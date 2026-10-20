package providers

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// List is the ordered provider catalogue the app offers. Neko (megaplay) is
// the original source; Ahiru, Inu and Tora are the newer mirrors.
func List() []Provider {
	return []Provider{NewNeko(), NewAhiru(), NewInu(), NewTora()}
}

// Find returns a provider by id ("" or unknown ids resolve to nil).
func Find(id string) Provider {
	for _, provider := range List() {
		if provider.ID() == id {
			return provider
		}
	}
	return nil
}

// Error is what Resolve returns when nothing in the chain could serve the
// episode; callers can test with errors.Is(err, ErrNotFound).
type ChainError struct {
	Kind     Kind
	Attempts []string
	// Timeout is set when at least one provider failed because it ran out of
	// time rather than because it does not carry the episode. The two cases are
	// reported differently: a timeout is retryable and says so.
	Timeout bool
}

func (e *ChainError) Error() string {
	reason := "no provider had this episode"
	if e.Timeout {
		reason = "stream sources timed out"
	}
	return fmt.Sprintf("%s in %s (%d tried)", reason, e.Kind, len(e.Attempts))
}

// Unwrap keeps the not-found contract: a chain that definitively found nothing
// still matches ErrNotFound, so the caller can fall back to another resolver.
// A timeout deliberately does not, because retrying is the right response.
func (e *ChainError) Unwrap() error {
	if e.Timeout {
		return nil
	}
	return ErrNotFound
}

// ProviderBudget is how long one provider gets before the chain moves on. A
// dead mirror that accepts the connection and then stalls must not consume the
// whole request: the old shared deadline let the first provider starve the
// rest, which looked like "no provider has this episode" for an episode that
// two other providers could serve.
const ProviderBudget = 12 * time.Second

// Resolve walks the configured providers (preferred first) and returns the
// first stream. Each provider gets its own time budget; a provider that reports
// ErrNotFound is skipped, and any other failure is recorded and the chain
// continues, so one broken mirror cannot take playback down.
func Resolve(
	ctx context.Context,
	preferred []string,
	malID, episode int,
	kind Kind,
	serverFor func(providerID string) string,
) (*Stream, error) {
	order := List()
	if len(preferred) > 0 {
		sorted := make([]Provider, 0, len(order))
		for _, id := range preferred {
			if provider := Find(id); provider != nil {
				sorted = append(sorted, provider)
			}
		}
		for _, provider := range order {
			found := false
			for _, existing := range sorted {
				if existing.ID() == provider.ID() {
					found = true
					break
				}
			}
			if !found {
				sorted = append(sorted, provider)
			}
		}
		order = sorted
	}

	var attempts []string
	timedOut := false
	for _, provider := range order {
		if ctx.Err() != nil {
			timedOut = true
			attempts = append(attempts, provider.ID()+": request deadline reached")
			break
		}

		server := ""
		if serverFor != nil {
			server = serverFor(provider.ID())
		}

		// One budget per provider, bounded by whatever is left of the caller's
		// deadline.
		providerCtx, cancel := context.WithTimeout(ctx, ProviderBudget)
		stream, err := ResolveWithFailover(providerCtx, provider, malID, episode, kind, server)
		cancel()
		if err == nil {
			return stream, nil
		}
		if errors.Is(err, ErrNotFound) && !isTimeout(err) {
			attempts = append(attempts, provider.ID()+": not found")
			continue
		}
		if isTimeout(err) || errors.Is(err, context.DeadlineExceeded) {
			timedOut = true
		}
		attempts = append(attempts, provider.ID()+": "+err.Error())
	}
	return nil, &ChainError{Kind: kind, Attempts: attempts, Timeout: timedOut}
}

// isTimeout recognises deadline exhaustion at any depth of the error chain.
func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}

// IsNotFound reports whether a resolve failure means "not carried anywhere".
// Timeouts are not "not found": the episode may well exist, the mirror was just
// too slow, and reporting it as missing is what made a working episode look
// gone.
func IsNotFound(err error) bool {
	if err == nil {
		return false
	}
	var chain *ChainError
	if errors.As(err, &chain) {
		return !chain.Timeout
	}
	return errors.Is(err, ErrNotFound)
}
