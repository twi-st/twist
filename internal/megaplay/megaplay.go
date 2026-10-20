package megaplay

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	baseURL       = "https://megaplay.buzz"
	playerReferer = "https://megaplay.buzz/"
	playerOrigin  = "https://megaplay.buzz"
	pageReferer   = "https://example.com/"
	userAgent     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	sourcesKey = "i?LMTAx0Q6,:}50U"
	sourcesIV  = "W0;27ToaUpl_P%'c"
	tokenKey   = "MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s"

	tokenTTL = 90 * time.Second
)

var (
	dataIDPattern  = regexp.MustCompile(`data-id="([^"]+)"`)
	pathKeyPattern = regexp.MustCompile(`/([a-f0-9]{32})/([a-f0-9]{32})/`)
	uriPattern     = regexp.MustCompile(`URI="([^"]+)"`)
)

type Range struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Track struct {
	URL      string `json:"url"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Default  bool   `json:"default"`
	File     string `json:"file,omitempty"`
}

type Source struct {
	StreamURL string
	Type      string
	MalID     int
	Episode   int
	DataID    string
	File      string
	Tracks    []Track
	Intro     *Range
	Outro     *Range
	Server    string
	FetchedAt time.Time
}

type Variant struct {
	URL        string
	Bandwidth  int
	Resolution string
	Height     int
	FrameRate  float64
	Label      string
	// Codecs is the master playlist CODECS attribute ("avc1.640028,mp4a.40.2").
	Codecs string
}

type Resolver struct {
	client *http.Client
}

func New() *Resolver {
	return &Resolver{
		client: &http.Client{Timeout: 25 * time.Second},
	}
}

func (r *Resolver) request(ctx context.Context, method, target string, headers map[string]string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", userAgent)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return r.client.Do(req)
}

func (r *Resolver) getText(ctx context.Context, target string, headers map[string]string) (string, error) {
	res, err := r.request(ctx, http.MethodGet, target, headers, nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return "", err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return string(data), nil
}

func (r *Resolver) getJSON(ctx context.Context, target string, headers map[string]string, out any) error {
	text, err := r.getText(ctx, target, headers)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(text), out)
}

type sourcesResponse struct {
	Enc     string          `json:"enc"`
	Sources json.RawMessage `json:"sources"`
	Tracks  []struct {
		File    string `json:"file"`
		Label   string `json:"label"`
		Default bool   `json:"default"`
	} `json:"tracks"`
	Intro   *Range `json:"intro"`
	Outro   *Range `json:"outro"`
	Error   any    `json:"error"`
	Message string `json:"message"`
	Server  json.RawMessage `json:"server"`
}

type sourcesPayload struct {
	File string `json:"file"`
}

func (r *Resolver) Resolve(ctx context.Context, malID, episode int, kind string) (*Source, error) {
	if malID <= 0 || episode <= 0 {
		return nil, errors.New("malId and episode must be positive")
	}
	if kind != "sub" && kind != "dub" && kind != "hsub" {
		return nil, fmt.Errorf("unsupported type %q", kind)
	}

	// Upstream occasionally answers a transient 404 for a route it does serve.
	// Try the requested track twice before falling back to hardsubs, which the
	// site uses for some titles where "sub" is not published.
	tracks := []string{kind}
	if kind == "sub" {
		tracks = append(tracks, "hsub")
	}
	var lastErr error
	for _, track := range tracks {
		for attempt := 0; attempt < 2; attempt++ {
			source, err := r.resolveOnce(ctx, malID, episode, track)
			if err == nil {
				return source, nil
			}
			lastErr = err
			if !IsNotFound(err) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(300 * time.Millisecond):
			}
		}
	}
	if lastErr == nil {
		lastErr = errNotFound
	}
	return nil, lastErr
}

func (r *Resolver) resolveOnce(ctx context.Context, malID, episode int, kind string) (*Source, error) {
	streamURL := fmt.Sprintf("%s/stream/mal/%d/%d/%s?_=%d", baseURL, malID, episode, kind, time.Now().UnixMilli())
	page, err := r.getText(ctx, streamURL, map[string]string{"referer": pageReferer})
	if err != nil {
		return nil, fmt.Errorf("stream page failed: %w", err)
	}
	dataID := dataIDPattern.FindStringSubmatch(page)
	if len(dataID) < 2 {
		return nil, errNotFound
	}

	sourcesURL := fmt.Sprintf("%s/stream/getSources?id=%s&platform=OTHER&_=%d", baseURL, url.QueryEscape(dataID[1]), time.Now().UnixMilli())
	var payload sourcesResponse
	err = r.getJSON(ctx, sourcesURL, map[string]string{
		"x-requested-with": "XMLHttpRequest",
		"referer":          playerReferer,
	}, &payload)
	if err != nil {
		return nil, fmt.Errorf("getSources failed: %w", err)
	}
	if payload.Error != nil {
		return nil, errNotFound
	}

	file := ""
	if payload.Enc != "" {
		decrypted, err := decryptSources(payload.Enc)
		if err != nil {
			return nil, fmt.Errorf("could not decrypt sources: %w", err)
		}
		file = decrypted.File
	} else if len(payload.Sources) > 0 {
		var direct sourcesPayload
		if json.Unmarshal(payload.Sources, &direct) == nil {
			file = direct.File
		}
	}
	if file == "" {
		return nil, errors.New("sources response did not contain a file url")
	}

	signed, err := AttachToken(file, tokenTTL)
	if err != nil {
		return nil, err
	}

	tracks := make([]Track, 0, len(payload.Tracks))
	for _, track := range payload.Tracks {
		label := track.Label
		if label == "" {
			label = "Unknown"
		}
		tracks = append(tracks, Track{
			URL:      track.File,
			Label:    label,
			Language: guessLanguage(track.Label, track.File),
			Default:  track.Default,
		})
	}

	return &Source{
		StreamURL: streamURL,
		Type:      kind,
		MalID:     malID,
		Episode:   episode,
		DataID:    dataID[1],
		File:      signed,
		Tracks:    tracks,
		Intro:     normalizeRange(payload.Intro),
		Outro:     normalizeRange(payload.Outro),
		Server:    rawString(payload.Server),
		FetchedAt: time.Now(),
	}, nil
}

var errNotFound = errors.New("stream not found")

func IsNotFound(err error) bool {
	return errors.Is(err, errNotFound)
}

func normalizeRange(value *Range) *Range {
	if value == nil || value.End <= value.Start {
		return nil
	}
	return value
}

func decryptSources(value string) (*sourcesPayload, error) {
	text := strings.TrimSpace(value)
	text = strings.ReplaceAll(text, "-", "+")
	text = strings.ReplaceAll(text, "_", "/")
	text = strings.TrimRight(text, "=")
	if remainder := len(text) % 4; remainder != 0 {
		text += strings.Repeat("=", 4-remainder)
	}
	data, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, err
	}
	key := pad([]byte(sourcesKey), 32)
	iv := pad([]byte(sourcesIV), 16)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, errors.New("invalid ciphertext")
	}
	plain := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, data)
	plain = unpad(plain)
	var payload sourcesPayload
	if err := json.Unmarshal(plain, &payload); err != nil {
		return nil, err
	}
	if payload.File == "" {
		return nil, errors.New("invalid payload")
	}
	return &payload, nil
}

func pad(value []byte, length int) []byte {
	out := make([]byte, length)
	copy(out, value)
	return out
}

func unpad(value []byte) []byte {
	if len(value) == 0 {
		return value
	}
	last := int(value[len(value)-1])
	if last <= 0 || last > aes.BlockSize || last > len(value) {
		return value
	}
	for _, b := range value[len(value)-last:] {
		if int(b) != last {
			return value
		}
	}
	return value[:len(value)-last]
}

func extractPathKey(target string) string {
	match := pathKeyPattern.FindStringSubmatch(target)
	if len(match) < 3 {
		return ""
	}
	return strings.ToLower(match[1] + "/" + match[2])
}

func signToken(pathKey string, ttl time.Duration) string {
	message := fmt.Sprintf("%d|%s", time.Now().Add(ttl).Unix(), pathKey)
	mac := hmac.New(sha256.New, []byte(tokenKey))
	mac.Write([]byte(message))
	signature := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString([]byte(message)) + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// AttachToken adds a fresh CDN token to URLs that use the signed path shape.
func AttachToken(target string, ttl time.Duration) (string, error) {
	pathKey := extractPathKey(target)
	if pathKey == "" {
		return target, nil
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("token", signToken(pathKey, ttl))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// SignWith applies a fresh token to every URL sharing the source's path key.
// Used when a signed playlist is re-read right before a long segment fetch.
func SignWith(target, reference string, ttl time.Duration) (string, error) {
	pathKey := extractPathKey(reference)
	if pathKey == "" || extractPathKey(target) == "" {
		return target, nil
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("token", signToken(pathKey, ttl))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func (r *Resolver) MasterVariants(ctx context.Context, playlistURL string) ([]Variant, error) {
	text, err := r.getText(ctx, playlistURL, map[string]string{
		"referer": playerReferer,
		"origin":  playerOrigin,
	})
	if err != nil {
		return nil, err
	}
	return ParseMaster(text, playlistURL), nil
}

func ParseMaster(text, base string) []Variant {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	variants := make([]Variant, 0)
	for index, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#EXT-X-STREAM-INF") {
			continue
		}
		if index+1 >= len(lines) {
			continue
		}
		uri := strings.TrimSpace(lines[index+1])
		if uri == "" || strings.HasPrefix(uri, "#") {
			continue
		}
		resolved, err := resolveURL(base, uri)
		if err != nil {
			continue
		}
		attrs := parseAttributes(line)
		bandwidth, _ := strconv.Atoi(attrs["BANDWIDTH"])
		if bandwidth == 0 {
			bandwidth, _ = strconv.Atoi(attrs["AVERAGE-BANDWIDTH"])
		}
		height := 0
		if resolution := attrs["RESOLUTION"]; resolution != "" {
			parts := strings.Split(strings.ToLower(resolution), "x")
			if len(parts) == 2 {
				height, _ = strconv.Atoi(parts[1])
			}
		}
		label := "auto"
		if height > 0 {
			label = fmt.Sprintf("%dp", height)
		} else if bandwidth > 0 {
			label = fmt.Sprintf("%dkbps", bandwidth/1000)
		}
		frameRate, _ := strconv.ParseFloat(attrs["FRAME-RATE"], 64)
		variants = append(variants, Variant{
			URL:        resolved,
			Bandwidth:  bandwidth,
			Resolution: attrs["RESOLUTION"],
			Height:     height,
			FrameRate:  frameRate,
			Label:      label,
			Codecs:     attrs["CODECS"],
		})
	}
	sort.Slice(variants, func(i, j int) bool {
		return variants[i].Bandwidth > variants[j].Bandwidth
	})
	return variants
}

func parseAttributes(line string) map[string]string {
	attrs := map[string]string{}
	start := strings.Index(line, ":")
	if start < 0 {
		return attrs
	}
	rest := line[start+1:]
	var current strings.Builder
	inQuotes := false
	flush := func() {
		part := strings.TrimSpace(current.String())
		current.Reset()
		if part == "" {
			return
		}
		eq := strings.Index(part, "=")
		if eq <= 0 {
			return
		}
		key := strings.ToUpper(strings.TrimSpace(part[:eq]))
		value := strings.Trim(strings.TrimSpace(part[eq+1:]), `"`)
		attrs[key] = value
	}
	for _, char := range rest {
		switch char {
		case '"':
			inQuotes = !inQuotes
			current.WriteRune(char)
		case ',':
			if inQuotes {
				current.WriteRune(char)
			} else {
				flush()
			}
		default:
			current.WriteRune(char)
		}
	}
	flush()
	return attrs
}

func (r *Resolver) PlaylistText(ctx context.Context, target string) (string, error) {
	return r.getText(ctx, target, map[string]string{
		"referer": playerReferer,
		"origin":  playerOrigin,
	})
}

func resolveURL(base, reference string) (string, error) {
	baseURL, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(reference)
	if err != nil {
		return "", err
	}
	return baseURL.ResolveReference(ref).String(), nil
}

// PickVariant selects the variant matching a label like "1080p", falling back
// to the highest bandwidth rendition.
func PickVariant(variants []Variant, quality string) *Variant {
	if len(variants) == 0 {
		return nil
	}
	if quality != "" && quality != "auto" {
		for index := range variants {
			if strings.EqualFold(variants[index].Label, quality) || strings.EqualFold(variants[index].Resolution, quality) {
				return &variants[index]
			}
		}
		if height, err := strconv.Atoi(strings.TrimSuffix(quality, "p")); err == nil {
			for index := range variants {
				if variants[index].Height == height {
					return &variants[index]
				}
			}
		}
	}
	return &variants[0]
}

func guessLanguage(label, file string) string {
	languages := map[string]string{
		"arabic": "ar", "english": "en", "french": "fr", "german": "de",
		"italian": "it", "portuguese": "pt", "russian": "ru", "spanish": "es",
	}
	cleaned := strings.ToLower(strings.TrimSpace(strings.Split(label, "(")[0]))
	if code, ok := languages[cleaned]; ok {
		return code
	}
	name := strings.Split(strings.Split(file, "/")[len(strings.Split(file, "/"))-1], ".")[0]
	name = strings.Split(name, "-")[0]
	if code, ok := languages[name]; ok {
		return code
	}
	return name
}

// rawString accepts either a JSON string or a number for fields whose type
// varies between megaplay deployments (e.g. "server": 4).
func rawString(value json.RawMessage) string {
	if len(value) == 0 || string(value) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(value, &text) == nil {
		return text
	}
	return strings.Trim(string(value), `"`)
}

func NormalizeKind(kind string) string {
	value := strings.ToLower(strings.TrimSpace(kind))
	if value != "dub" && value != "hsub" {
		return "sub"
	}
	return value
}
