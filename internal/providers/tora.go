package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Tora is the zokoanime.video mirror.
//
// It exposes an embed page per episode (`/stream/{source}/{id}/{episode}/{track}`)
// whose only dynamic content is a base64 + XOR-obfuscated JSON payload. That
// payload carries the signed master playlist, subtitle tracks and the intro /
// outro markers, so one request is enough — there is no server list and no
// second API call.
//
// The mirror is single-server: `Servers` is empty, which makes the chain skip
// the server race for it.
type Tora struct{}

func NewTora() *Tora { return &Tora{} }

func (t *Tora) ID() string   { return "tora" }
func (t *Tora) Name() string { return "Tora" }

func (t *Tora) Servers() []Server { return nil }

const (
	toraBase    = "https://zokoanime.video"
	toraReferer = "https://zokoanime.video/"
	toraOrigin  = "https://zokoanime.video"
	// obfuscationKey is the constant the site's own player uses; it is baked
	// into their deobfuscate() helper, not a secret.
	obfuscationKey = "otaku-embed-v1"
)

// toraPayload is the decoded embed document.
type toraPayload struct {
	Src       string `json:"src"`
	Subtitles []struct {
		Src      string `json:"src"`
		Label    string `json:"label"`
		Lang     string `json:"lang"`
		Default  bool   `json:"default"`
	} `json:"subtitles"`
	Skip struct {
		Intro *Range `json:"intro"`
		Outro *Range `json:"outro"`
	} `json:"skip"`
	VideoID int `json:"video_id"`
}

// payloadPattern captures the obfuscated blob out of the embed page.
var payloadPattern = regexp.MustCompile(`window\.__P="([^"]+)"`)

// deobfuscate mirrors the site's helper: base64, then XOR against the key.
func deobfuscate(blob string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(blob))
	if err != nil {
		return nil, fmt.Errorf("tora: bad payload: %w", err)
	}
	out := make([]byte, len(raw))
	for i := range raw {
		out[i] = raw[i] ^ obfuscationKey[i%len(obfuscationKey)]
	}
	return out, nil
}

// fetchPayload asks the embed page for one episode and decodes its payload.
func (t *Tora) fetchPayload(ctx context.Context, malID, episode int, track string) (*toraPayload, error) {
	target := fmt.Sprintf("%s/stream/mal/%d/%d/%s", toraBase, malID, episode, track)
	status, body, err := get(ctx, target, toraReferer, toraOrigin, nil)
	if err != nil {
		return nil, fmt.Errorf("tora: %w", err)
	}
	if status < 200 || status > 299 {
		return nil, providerError(status, body, "tora")
	}

	match := payloadPattern.FindSubmatch(body)
	if len(match) < 2 {
		// The page answers 200 with a human-readable "not found" card for a
		// missing episode or track, so a missing payload means "not carried".
		return nil, ErrNotFound
	}
	decoded, err := deobfuscate(string(match[1]))
	if err != nil {
		return nil, err
	}
	var payload toraPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, fmt.Errorf("tora: bad payload json: %w", err)
	}
	if payload.Src == "" {
		return nil, ErrNotFound
	}
	return &payload, nil
}

func (t *Tora) Resolve(ctx context.Context, malID, episode int, kind Kind, server string) (*Stream, error) {
	if malID <= 0 || episode <= 0 {
		return nil, fmt.Errorf("tora: invalid mal id or episode")
	}
	_ = server // single-server mirror

	// "sub" is not published for every title; the site itself falls back to
	// hardsubs, and so do we.
	tracks := []string{KindSub}
	if normalizeKind(kind) == KindDub {
		tracks = []string{KindDub}
	} else {
		tracks = []string{KindSub, "hsub"}
	}

	var payload *toraPayload
	var lastErr error
	for _, track := range tracks {
		next, err := t.fetchPayload(ctx, malID, episode, track)
		if err != nil {
			lastErr = err
			if isTimeout(err) || ctx.Err() != nil {
				return nil, err
			}
			continue
		}
		payload = next
		break
	}
	if payload == nil {
		if lastErr == nil {
			lastErr = ErrNotFound
		}
		return nil, lastErr
	}

	stream := &Stream{
		Provider: t.ID(),
		URL:      payload.Src,
		Referer:  toraReferer,
		Origin:   toraOrigin,
		Fetched:  time.Now(),
	}
	if payload.Skip.Intro != nil {
		stream.Intro = normalizeRange(payload.Skip.Intro)
	}
	if payload.Skip.Outro != nil {
		stream.Outro = normalizeRange(payload.Skip.Outro)
	}
	for _, item := range payload.Subtitles {
		if item.Src == "" {
			continue
		}
		// Subtitle files sit on the same CDN as the video, which also wants the
		// embed origin.
		referer, origin := toraReferer, toraOrigin
		if parsed, err := url.Parse(item.Src); err == nil && parsed.Host != "" {
			referer = "https://" + parsed.Host + "/"
			origin = "https://" + parsed.Host
		}
		// The site labels every track "en" (the file is English-encoded VTT
		// regardless of the caption language), so the label is the better
		// source of truth: "Spanish", "Portuguese"… A generic "en" only wins
		// when the label says nothing useful.
		language := languageFromLabel(item.Label)
		if language == "" {
			language = strings.ToLower(strings.TrimSpace(item.Lang))
		}
		if language == "" {
			language = guessLanguage(item.Label, item.Src)
		}
		stream.Tracks = append(stream.Tracks, Track{
			URL:      item.Src,
			Label:    labelOr(item.Label, "English"),
			Language: language,
			Default:  item.Default,
			Referer:  referer,
			Origin:   origin,
		})
	}
	return stream, nil
}

// languageFromLabel maps a caption label ("Spanish", "English 2",
// "English (- (Crunchyroll))") onto an ISO code, or "" when it says nothing
// about the language.
func languageFromLabel(label string) string {
	lower := strings.ToLower(strings.TrimSpace(label))
	if lower == "" {
		return ""
	}
	for name, code := range map[string]string{
		"english": "en", "spanish": "es", "portuguese": "pt", "french": "fr",
		"german": "de", "italian": "it", "russian": "ru", "arabic": "ar",
		"japanese": "ja", "korean": "ko", "chinese": "zh", "indonesian": "id",
		"turkish": "tr", "polish": "pl", "dutch": "nl", "hindi": "hi",
		"vietnamese": "vi", "thai": "th", "malay": "ms", "filipino": "fil",
	} {
		if strings.Contains(lower, name) {
			return code
		}
	}
	return ""
}
