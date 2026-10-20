package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Ahiru is the megavid.buzz player. Its own player fetches a source document
// per episode from /mal/{id}/{ep}/{track}/source, which carries the signed
// playlist, subtitle tracks, chapter markers and the list of upstream servers
// (zuna, yuki, sora, loli, nero). Those are used directly â€” the site's /api
// route is only a third-party relay and is deliberately not used here.
type Ahiru struct{}

func NewAhiru() *Ahiru { return &Ahiru{} }

func (a *Ahiru) ID() string   { return "ahiru" }
func (a *Ahiru) Name() string { return "Ahiru" }

// ahiruUpstreams maps the numbered servers shown in the player onto megavid's
// own upstream ids. The names are an implementation detail of the mirror, so
// the UI only ever sees ahiru-1 ... ahiru-5 (same schema as inu).
var ahiruUpstreams = []string{"zuna", "yuki", "sora", "loli", "nero"}

func (a *Ahiru) Servers() []Server {
	servers := make([]Server, 0, len(ahiruUpstreams))
	for index, id := range ahiruUpstreams {
		servers = append(servers, Server{ID: fmt.Sprintf("%d", index+1), Name: fmt.Sprintf("%d", index+1), Upstream: id})
	}
	return servers
}

const (
	ahiruBase    = "https://megavid.buzz"
	ahiruReferer = "https://megavid.buzz/"
	ahiruOrigin  = "https://megavid.buzz"
)

type ahiruSource struct {
	Status   string `json:"status"`
	Source   string `json:"source"`
	Message  string `json:"message"`
	Tracks   []struct {
		File    string `json:"file"`
		Label   string `json:"label"`
		Kind    string `json:"kind"`
		Default bool   `json:"default"`
	} `json:"tracks"`
	Provider  string `json:"provider"`
	Providers []struct {
		ID  string `json:"id"`
		Tip string `json:"tip"`
	} `json:"providers"`
	Chapters []struct {
		Title string  `json:"title"`
		Start float64 `json:"start"`
		End   float64 `json:"end"`
	} `json:"chapters"`
	Type string `json:"type"`
}

// fetchSource asks the player for one server's source document.
func (a *Ahiru) fetchSource(ctx context.Context, malID, episode int, kind Kind, server string) (*ahiruSource, error) {
	target := fmt.Sprintf("%s/mal/%d/%d/%s/source", ahiruBase, malID, episode, kind)
	if server != "" {
		target += "?axsv=" + url.QueryEscape(server)
	}
	status, body, err := get(ctx, target, ahiruReferer, ahiruOrigin, nil)
	if err != nil {
		return nil, fmt.Errorf("ahiru: %w", err)
	}
	if status < 200 || status > 299 {
		return nil, providerError(status, body, "ahiru")
	}

	var payload ahiruSource
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("ahiru: bad response: %w", err)
	}
	if payload.Status != "ok" || payload.Source == "" {
		return nil, ErrNotFound
	}
	return &payload, nil
}

// Resolve returns the stream for one server. Server failover is the chain's
// job (providers.ResolveWithFailover), so this asks exactly one upstream:
// looping here as well meant up to ten requests per provider, which is what
// made a slow mirror look like a missing episode.
func (a *Ahiru) Resolve(ctx context.Context, malID, episode int, kind Kind, server string) (*Stream, error) {
	if malID <= 0 || episode <= 0 {
		return nil, fmt.Errorf("ahiru: invalid mal id or episode")
	}
	track := normalizeKind(kind)
	if track != KindDub {
		track = KindSub
	}

	// `server` is the numbered id the UI uses; translate it to megavid's
	// upstream. An empty id lets the player pick.
	payload, err := a.fetchSource(ctx, malID, episode, track, upstreamOf(a.Servers(), server))
	if err != nil {
		return nil, err
	}

	stream := &Stream{
		Provider: a.ID(),
		// Report the numbered server the UI knows, not the upstream name.
		Server:  serverIDOf(a.Servers(), providerOr(payload.Provider, server)),
		URL:     payload.Source,
		Referer: ahiruReferer,
		Origin:  ahiruOrigin,
		Fetched: time.Now(),
	}
	for _, chapter := range payload.Chapters {
		marker := &Range{Start: chapter.Start, End: chapter.End}
		switch strings.ToLower(chapter.Title) {
		case "intro", "opening":
			stream.Intro = normalizeRange(marker)
		case "outro", "ending":
			stream.Outro = normalizeRange(marker)
		}
	}
	for _, item := range payload.Tracks {
		if item.File == "" {
			continue
		}
		// The subtitle CDN (hls.dramahot.top) rejects megavid's referer;
		// it needs its own origin.
		referer, origin := ahiruReferer, ahiruOrigin
		if parsed, err := url.Parse(item.File); err == nil && parsed.Host != "" {
			referer = "https://" + parsed.Host + "/"
			origin = "https://" + parsed.Host
		}
		stream.Tracks = append(stream.Tracks, Track{
			URL:      item.File,
			Label:    labelOr(item.Label, "English"),
			Language: guessLanguage(item.Label, item.File),
			Default:  item.Default,
			Referer:  referer,
			Origin:   origin,
		})
	}
	return stream, nil
}
