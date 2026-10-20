package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// userAgent is sent with every provider request; both mirrors reject the
// default Go client string.
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// ErrNotFound means the provider does not carry this episode/track.
var ErrNotFound = errors.New("stream not found")

// Kind is the audio track requested from a provider.
type Kind = string

const (
	KindSub Kind = "sub"
	KindDub Kind = "dub"
)

// Track is one subtitle track the provider offers. `File` is set by the
// downloader once the track has been saved next to the episode.
type Track struct {
	URL      string `json:"url"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Default  bool   `json:"default"`
	File     string `json:"file,omitempty"`
	// Referer/Origin override the stream's headers for this track, because
	// subtitle CDNs often sit on a different host than the video.
	Referer string `json:"-"`
	Origin  string `json:"-"`
}

// Range is an intro/outro marker, in seconds.
type Range struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// Stream is a resolved episode: a master playlist plus metadata.
type Stream struct {
	Provider string
	/** Server id the provider actually served from. */
	Server   string
	URL      string
	Tracks   []Track
	Intro    *Range
	Outro    *Range
	Referer  string
	Origin   string
	Fetched  time.Time
}

// probeMaster checks that a resolved stream's master playlist actually loads
// with the provider headers, so a mirror that hands out a dead URL falls
// through to the next server.
//
// A timeout is not evidence that the stream is dead: these CDNs are routinely
// slow to first byte on a cold edge, and rejecting a working URL because the
// probe gave up made playable episodes look missing. Only a definitive HTTP
// failure rejects the stream; a timeout accepts it and lets the player (which
// streams through the local relay anyway) decide.
const probeTimeout = 6 * time.Second

func probeMaster(ctx context.Context, stream *Stream) error {
	if stream == nil || stream.URL == "" {
		return ErrNotFound
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	status, _, err := get(probeCtx, stream.URL, stream.Referer, stream.Origin, nil)
	if err != nil {
		if probeCtx.Err() != nil || isTimeout(err) {
			return nil
		}
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("%s: playlist HTTP %d", stream.Provider, status)
	}
	return nil
}

// ResolveWithFailover resolves one provider by racing its servers.
//
// Servers used to be tried one after another, so a slow edge (megavid's dub
// CDN takes ~10s on two of five upstreams) delayed playback even though
// another server would have answered in under a second. Now the requested
// server and the first few alternatives start together and the first playable
// stream wins; the rest are cancelled. The requested server is preferred on a
// tie, so an explicit choice is still honoured.
func ResolveWithFailover(ctx context.Context, provider Provider, malID, episode int, kind Kind, server string) (*Stream, error) {
	servers := provider.Servers()
	if len(servers) == 0 {
		return resolveWithin(ctx, provider, malID, episode, kind, server)
	}

	// Race at most three: more only adds load to a provider that is already
	// struggling, and the remaining servers are the fallback if all of these
	// fail outright.
	candidates := make([]string, 0, raceWidth)
	if server != "" {
		candidates = append(candidates, server)
	}
	for _, candidate := range servers {
		if len(candidates) >= raceWidth {
			break
		}
		if candidate.ID == server {
			continue
		}
		candidates = append(candidates, candidate.ID)
	}

	type result struct {
		stream *Stream
		err    error
	}
	raceCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make(chan result, len(candidates))
	for _, id := range candidates {
		go func(id string) {
			stream, err := resolveWithin(raceCtx, provider, malID, episode, kind, id)
			results <- result{stream: stream, err: err}
		}(id)
	}

	// First success wins and cancels the rest. The requested server is started
	// first (index 0), so a healthy choice is normally the one that answers.
	var firstErr error
	var notFound int
	for range candidates {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case result := <-results:
			if result.err == nil {
				cancel()
				return result.stream, nil
			}
			if firstErr == nil {
				firstErr = result.err
			}
			if errors.Is(result.err, ErrNotFound) {
				notFound++
			}
		}
	}
	// Every raced server failed: fall back to the servers that were not raced,
	// in order, before giving up on the provider.
	for _, candidate := range servers {
		if ctx.Err() != nil {
			break
		}
		raced := false
		for _, id := range candidates {
			if id == candidate.ID {
				raced = true
				break
			}
		}
		if raced {
			continue
		}
		next, err := resolveWithin(ctx, provider, malID, episode, kind, candidate.ID)
		if err == nil {
			return next, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if notFound == len(candidates) {
		return nil, ErrNotFound
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("%s: no playable server", provider.ID())
	}
	return nil, firstErr
}

// raceWidth is how many servers of one provider are tried simultaneously.
const raceWidth = 3

// resolveWithin runs one provider attempt (resolve + playlist probe) under a
// per-attempt slice of the remaining deadline.
func resolveWithin(ctx context.Context, provider Provider, malID, episode int, kind Kind, server string) (*Stream, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, attemptBudget(ctx))
	defer cancel()

	stream, err := provider.Resolve(attemptCtx, malID, episode, kind, server)
	if err != nil {
		return nil, err
	}
	if err := probeMaster(attemptCtx, stream); err != nil {
		return nil, err
	}
	return stream, nil
}

// attemptBudget divides what is left of the deadline across the attempts still
// worth making, with a floor so a nearly-expired budget still tries once.
func attemptBudget(ctx context.Context) time.Duration {
	remaining := ProviderBudget
	if deadline, ok := ctx.Deadline(); ok {
		remaining = time.Until(deadline)
	}
	// Two attempts are enough per server: the source call and the playlist
	// probe. Keep at least a few seconds so the last server is not skipped.
	share := remaining / 2
	if share < 4*time.Second {
		share = 4 * time.Second
	}
	return share
}

// Provider resolves one episode from a specific source.
type Provider interface {
	// ID is the stable provider key used by settings and the UI.
	ID() string
	// Name is what the player shows ("Ahiru", "Inu").
	Name() string
	// Servers lists the selectable sub-servers (empty for single-server ones).
	Servers() []Server
	// Resolve returns the stream for an episode, from the given server.
	Resolve(ctx context.Context, malID, episode int, kind Kind, server string) (*Stream, error)
}

// Server is one selectable sub-server inside a provider. `Upstream` is the
// provider's own name for it (never shown); the UI only uses ID.
type Server struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Upstream string `json:"-"`
}

// providerOr prefers the upstream the mirror reported, falling back to the one
// that was requested when the mirror omits it.
func providerOr(reported, requested string) string {
	if reported != "" {
		return reported
	}
	return requested
}

// serverIDOf maps an upstream name back to the numbered id the UI uses.
func serverIDOf(servers []Server, upstream string) string {
	for _, server := range servers {
		if server.Upstream == upstream {
			return server.ID
		}
	}
	return upstream
}

// upstreamOf resolves a numbered server id to the provider's own name.
func upstreamOf(servers []Server, id string) string {
	for _, server := range servers {
		if server.ID == id {
			if server.Upstream != "" {
				return server.Upstream
			}
			return id
		}
	}
	return id
}

// client is shared: both mirrors are small JSON endpoints. The transport has a
// response-header timeout because a mirror that accepts the connection and then
// stalls (megaplay has done this repeatedly) would otherwise hold the request
// until the whole provider budget expired, and every server behind it waited.
// These are small JSON calls, so eight seconds to first byte is generous.
var client = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		ExpectContinueTimeout: time.Second,
	},
}

// get performs a provider request with the headers the mirrors require.
func get(ctx context.Context, target, referer, origin string, extra map[string]string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("user-agent", userAgent)
	if referer != "" {
		req.Header.Set("referer", referer)
	}
	if origin != "" {
		req.Header.Set("origin", origin)
	}
	for key, value := range extra {
		req.Header.Set(key, value)
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return res.StatusCode, nil, err
	}
	return res.StatusCode, data, nil
}

// normalizeKind maps the UI's track names onto the providers' vocabulary.
func normalizeKind(kind string) Kind {
	return strings.ToLower(strings.TrimSpace(kind))
}

// providerError wraps a status code into the shared not-found sentinel when it
// means "this episode is not carried here".
func providerError(status int, body []byte, what string) error {
	text := strings.TrimSpace(string(body))
	if len(text) > 200 {
		text = text[:200]
	}
	if status == http.StatusNotFound {
		return ErrNotFound
	}
	return fmt.Errorf("%s: HTTP %d %s", what, status, text)
}
