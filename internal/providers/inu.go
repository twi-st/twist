package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

// Inu is the anixo.buzz mirror. It exposes one JSON resolver per upstream
// server (Sora, Zexy, Poko) so the player can switch servers without leaving
// the built-in player, and the downloader can pull the same streams.
type Inu struct{}

func NewInu() *Inu { return &Inu{} }

func (i *Inu) ID() string   { return "inu" }
func (i *Inu) Name() string { return "Inu" }

func (i *Inu) Servers() []Server {
	// Only ids are exposed: the upstream names are the mirror's business.
	return []Server{
		{ID: "1", Name: "1"},
		{ID: "2", Name: "2"},
		{ID: "3", Name: "3"},
	}
}

const (
	inuBase    = "https://anixo.buzz"
	inuReferer = "https://anixo.buzz/"
	inuOrigin  = "https://anixo.buzz"
)

type inuResponse struct {
	Success    bool   `json:"success"`
	Server     string `json:"server"`
	ServerID   int    `json:"serverId"`
	StreamURL  string `json:"streamUrl"`
	Subtitles  []struct {
		URL     string `json:"url"`
		Label   string `json:"label"`
		Kind    string `json:"kind"`
		Default bool   `json:"default"`
	} `json:"subtitles"`
	Intro *Range `json:"intro"`
	Outro *Range `json:"outro"`
	Error string `json:"error"`
}

func (i *Inu) Resolve(ctx context.Context, malID, episode int, kind Kind, server string) (*Stream, error) {
	if malID <= 0 || episode <= 0 {
		return nil, fmt.Errorf("inu: invalid mal id or episode")
	}
	track := normalizeKind(kind)
	if track != KindDub {
		track = KindSub
	}
	// One request for the requested server. Server failover belongs to the
	// chain (providers.ResolveWithFailover); looping here as well tripled the
	// requests and let a single slow upstream eat the whole budget.
	candidate := server
	if candidate == "" {
		candidate = "1"
	}
	query := url.Values{}
	query.Set("malId", fmt.Sprintf("%d", malID))
	query.Set("episode", fmt.Sprintf("%d", episode))
	query.Set("track", track)
	query.Set("server", candidate)
	target := inuBase + "/api/stream/resolve?" + query.Encode()

	status, body, err := get(ctx, target, inuReferer, inuOrigin, nil)
	if err != nil {
		return nil, fmt.Errorf("inu: %w", err)
	}
	if status < 200 || status > 299 {
		return nil, providerError(status, body, "inu")
	}
	var payload inuResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("inu: bad response: %w", err)
	}
	if !payload.Success || payload.StreamURL == "" {
		return nil, ErrNotFound
	}

	stream := &Stream{
		Provider: i.ID(),
		Server:   fmt.Sprintf("%d", payload.ServerID),
		URL:      payload.StreamURL,
		Referer:  inuReferer,
		Origin:   inuOrigin,
		Fetched:  time.Now(),
		Intro:    normalizeRange(payload.Intro),
		Outro:    normalizeRange(payload.Outro),
	}
	for _, item := range payload.Subtitles {
		if item.URL == "" {
			continue
		}
		stream.Tracks = append(stream.Tracks, Track{
			URL:      item.URL,
			Label:    labelOr(item.Label, "English"),
			Language: guessLanguage(item.Label, item.URL),
			Default:  item.Default,
		})
	}
	return stream, nil
}
