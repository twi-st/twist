package providers

import (
	"context"
	"time"

	"twisted/internal/megaplay"
)

// Neko is the megaplay.buzz provider: the original source, kept as its own
// mirror so the player offers it alongside the other two.
type Neko struct {
	resolver *megaplay.Resolver
}

func NewNeko() *Neko { return &Neko{resolver: megaplay.New()} }

func (n *Neko) ID() string   { return "neko" }
func (n *Neko) Name() string { return "Neko" }
func (n *Neko) Servers() []Server {
	return nil
}

func (n *Neko) Resolve(ctx context.Context, malID, episode int, kind Kind, _ string) (*Stream, error) {
	source, err := n.resolver.Resolve(ctx, malID, episode, megaplay.NormalizeKind(kind))
	if err != nil {
		if megaplay.IsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	stream := &Stream{
		Provider: n.ID(),
		URL:      source.File,
		Referer:  "https://megaplay.buzz/",
		Origin:   "https://megaplay.buzz",
		Fetched:  source.FetchedAt,
	}
	if stream.Fetched.IsZero() {
		stream.Fetched = time.Now()
	}
	if source.Intro != nil {
		stream.Intro = &Range{Start: source.Intro.Start, End: source.Intro.End}
	}
	if source.Outro != nil {
		stream.Outro = &Range{Start: source.Outro.Start, End: source.Outro.End}
	}
	for _, track := range source.Tracks {
		stream.Tracks = append(stream.Tracks, Track{
			URL:      track.URL,
			Label:    track.Label,
			Language: track.Language,
			Default:  track.Default,
		})
	}
	return stream, nil
}
