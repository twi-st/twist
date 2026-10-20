package proxy

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"twisted/internal/cache"
	"twisted/internal/subtitles"
)

const (
	homeBody = "cors proxy"
	maxURL   = 4096
	maxBody  = 8 << 20
)

type Relay struct {
	server  *http.Server
	listen  net.Listener
	cache   *cache.Cache
	enabled bool
	client  *http.Client
	mu      sync.Mutex
	handler http.Handler
	kuma    http.Handler
	// prefix makes Wrap produce same-origin URLs (e.g. "/relay") so the
	// webview never loads media or subtitles from another origin.
	prefix string
}

var (
	headerNamePattern  = regexp.MustCompile(`^[a-z0-9!#$%&'*+\-.^_` + "`" + `|~]+$`)
	headerValuePattern = regexp.MustCompile(`^[\t\x20-\x7e\x80-\xff]*$`)
)

var blockedHeaders = map[string]bool{
	"host": true, "content-length": true, "connection": true,
	"transfer-encoding": true, "upgrade": true, "x-forwarded-for": true,
	"x-real-ip": true, "cf-connecting-ip": true,
}

var forwardHeaders = []string{"content-type", "content-range", "accept-ranges", "etag", "last-modified"}

// Volatile params only cover cache-busting noise. Signed tokens (`t`, `ts`,
// `timestamp`) must stay in the key: some mirrors (anixo) serve the master,
// the media playlist and every segment from one path and differ only by the
// token, so dropping it would hand a cached segment to the playlist request.
var volatileParams = []string{"_", "cb", "cachebuster", "nocache"}

func New(disk *cache.Cache, enabled bool) (*Relay, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	relay := &Relay{
		listen:  listener,
		cache:   disk,
		enabled: enabled,
		client: &http.Client{
			Timeout: 0,
			Transport: &http.Transport{
				Proxy:                 nil,
				MaxIdleConns:          64,
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: 30 * time.Second,
			},
		},
	}
	relay.server = &http.Server{
		Handler:           http.HandlerFunc(relay.handle),
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		_ = relay.server.Serve(listener)
	}()
	return relay, nil
}

func (r *Relay) BaseURL() string {
	return "http://" + r.listen.Addr().String()
}

// ServeHTTP exposes the relay for mounting inside the app's asset server, so
// proxied media shares the webview's origin.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.handle(w, req)
}

// SetPrefix routes every wrapped URL through a path on the app's own origin
// instead of the loopback port. `<track>` elements and media requests are
// blocked by the webview when the origin differs, so same-origin is required.
func (r *Relay) SetPrefix(prefix string) {
	r.mu.Lock()
	r.prefix = strings.TrimSuffix(prefix, "/")
	r.mu.Unlock()
}

// PublicBase is the origin wrapped URLs use (same-origin when mounted).
func (r *Relay) PublicBase() string {
	return r.publicBase()
}

// publicBase is the origin wrapped URLs use.
func (r *Relay) publicBase() string {
	r.mu.Lock()
	prefix := r.prefix
	r.mu.Unlock()
	if prefix != "" {
		return prefix
	}
	return r.BaseURL()
}

func (r *Relay) SetDownloadHandler(handler http.Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handler = handler
}

// SetKumaHandler mounts the torrent engine's generated HLS files at /kuma/.
func (r *Relay) SetKumaHandler(handler http.Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.kuma = handler
}

func (r *Relay) Wrap(target string) string {
	return r.WrapWith(target, "https://megaplay.buzz/", "https://megaplay.buzz")
}

// WrapWith sends a URL through the local relay with a specific referer/origin,
// which every mirror and its CDN require.
func (r *Relay) WrapWith(target, referer, origin string) string {
	query := url.Values{}
	query.Set("url", target)
	query.Set("rewrite", "1")
	headers := map[string]string{}
	if referer != "" {
		headers["Referer"] = referer
	}
	if origin != "" {
		headers["Origin"] = origin
	}
	if len(headers) > 0 {
		encoded, err := json.Marshal(headers)
		if err == nil {
			query.Set("headers", string(encoded))
		}
	}
	return r.publicBase() + "/?" + query.Encode()
}

func (r *Relay) Close() {
	_ = r.server.Close()
}

func (r *Relay) SetEnabled(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.enabled = enabled
	if r.cache != nil {
		r.cache.SetEnabled(enabled)
	}
}

func privateHost(hostname string) bool {
	host := strings.ToLower(strings.Trim(hostname, "[]"))
	if host == "" || host == "localhost" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") {
		return true
	}
	if strings.Contains(host, ":") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
}

func parseTarget(value string) (*url.URL, bool) {
	if value == "" || len(value) > maxURL {
		return nil, false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.User != nil || privateHost(parsed.Hostname()) {
		return nil, false
	}
	return parsed, true
}

type control struct {
	URL     string          `json:"url"`
	Method  string          `json:"method"`
	Headers json.RawMessage `json:"headers"`
	Body    string          `json:"body"`
	Rewrite any             `json:"rewrite"`
	Cache   any             `json:"cache"`
}

func normalizeHeaders(raw json.RawMessage) (map[string]string, bool) {
	headers := map[string]string{}
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return headers, true
	}
	var source any
	if err := json.Unmarshal(raw, &source); err != nil {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return nil, false
		}
		if text == "" {
			return headers, true
		}
		if err := json.Unmarshal([]byte(text), &source); err != nil {
			return nil, false
		}
	}
	var pairs [][]string
	switch value := source.(type) {
	case map[string]any:
		for key, entry := range value {
			text, ok := entry.(string)
			if !ok {
				return nil, false
			}
			pairs = append(pairs, []string{key, text})
		}
	case []any:
		for _, item := range value {
			pair, ok := item.([]any)
			if !ok || len(pair) != 2 {
				return nil, false
			}
			name, okName := pair[0].(string)
			text, okValue := pair[1].(string)
			if !okName || !okValue {
				return nil, false
			}
			pairs = append(pairs, []string{name, text})
		}
	default:
		return nil, false
	}
	if len(pairs) > 24 {
		return nil, false
	}
	for _, pair := range pairs {
		name := strings.ToLower(strings.TrimSpace(pair[0]))
		value := pair[1]
		if !headerNamePattern.MatchString(name) || strings.HasPrefix(name, "cf-") || blockedHeaders[name] {
			return nil, false
		}
		if len(value) > 2048 || !headerValuePattern.MatchString(value) {
			return nil, false
		}
		headers[name] = value
	}
	return headers, true
}

func (r *Relay) handle(w http.ResponseWriter, req *http.Request) {
	setCORS(w)
	if req.Method == http.MethodOptions {
		if requested := req.Header.Get("access-control-request-headers"); requested != "" {
			w.Header().Set("access-control-allow-headers", requested)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	requestPath := req.URL.Path
	if strings.HasPrefix(requestPath, "/relay/") || requestPath == "/relay" {
		// Mounted inside the app origin: the path prefix is only cosmetic, the
		// query string carries the real target.
		requestPath = strings.TrimPrefix(requestPath, "/relay")
		if requestPath == "" {
			requestPath = "/"
		}
		req.URL.Path = requestPath
	}
	if strings.HasPrefix(requestPath, "/kuma/") {
		r.mu.Lock()
		handler := r.kuma
		r.mu.Unlock()
		if handler == nil {
			notFound(w)
			return
		}
		handler.ServeHTTP(w, req)
		return
	}
	if strings.HasPrefix(requestPath, "/downloads/") {
		r.mu.Lock()
		handler := r.handler
		r.mu.Unlock()
		if handler == nil {
			notFound(w)
			return
		}
		handler.ServeHTTP(w, req)
		return
	}

	if req.Method == http.MethodGet && req.URL.RawQuery == "" && (requestPath == "/" || requestPath == "") {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, homeBody)
		return
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead && req.Method != http.MethodPost {
		notFound(w)
		return
	}

	var payload control
	if req.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(req.Body, maxBody+1))
		if err != nil || len(body) > maxBody {
			notFound(w)
			return
		}
		if json.Unmarshal(body, &payload) != nil {
			notFound(w)
			return
		}
	} else {
		query := req.URL.Query()
		payload.URL = query.Get("url")
		payload.Method = query.Get("method")
		payload.Body = query.Get("body")
		if raw := query.Get("headers"); raw != "" {
			payload.Headers = json.RawMessage(raw)
		}
		if raw := query.Get("rewrite"); raw != "" {
			payload.Rewrite = raw
		}
		if raw := query.Get("cache"); raw != "" {
			payload.Cache = raw
		}
	}

	target, ok := parseTarget(payload.URL)
	if !ok {
		notFound(w)
		return
	}
	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead && method != http.MethodPost {
		notFound(w)
		return
	}
	headers, ok := normalizeHeaders(payload.Headers)
	if !ok {
		notFound(w)
		return
	}
	rewrite := wantsRewrite(payload.Rewrite)
	ttl, ttlSet := parseTTL(payload.Cache)
	if ttlSet && ttl < 0 {
		notFound(w)
		return
	}

	cacheKey := ""
	if method == http.MethodGet && r.cacheEnabled() {
		cacheKey = cache.Key("relay", cacheableURL(target.String()), boolString(rewrite))
		if data, contentType, hit := r.cache.Get(cacheKey); hit {
			if contentType != "" {
				w.Header().Set("content-type", contentType)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
	}

	var body io.Reader
	if payload.Body != "" {
		body = strings.NewReader(payload.Body)
	}
	upstream, err := http.NewRequestWithContext(req.Context(), method, target.String(), body)
	if err != nil {
		notFound(w)
		return
	}
	for name, value := range headers {
		upstream.Header.Set(name, value)
	}
	if rangeHeader := req.Header.Get("range"); rangeHeader != "" {
		upstream.Header.Set("range", rangeHeader)
	}

	response, err := r.client.Do(upstream)
	if err != nil {
		notFound(w)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		if response.StatusCode != http.StatusPartialContent {
			notFound(w)
			return
		}
	}

	contentType := response.Header.Get("content-type")
	// Only trust a mpegurl content type or an .m3u8 path here. Some CDNs label
	// real HLS as image/jpeg *and* serve .ts segments with that type, so a
	// broad jpeg check would rewrite binary segments into broken playlists.
	// Unknown payloads are sniffed for #EXTM3U below instead.
	isPlaylist := strings.Contains(strings.ToLower(contentType), "mpegurl") ||
		regexp.MustCompile(`(?i)\.m3u8?(\?|$)`).MatchString(target.Path)
	// Child URLs must use the same public origin as the wrapped request,
	// otherwise the webview rejects them as cross-origin.
	base := r.publicBase()

	// Subtitles from the addons are SubRip, which a <track> element refuses.
	// Detect them by type or extension and hand back WebVTT instead. This runs
	// before the playlist logic because an .srt can never be a playlist.
	if method != http.MethodHead && looksLikeSubtitle(contentType, target.Path) {
		body, err := io.ReadAll(io.LimitReader(response.Body, maxBody))
		if err != nil {
			notFound(w)
			return
		}
		text := string(body)
		if subtitles.LooksLikeSRT(text) {
			text = subtitles.ConvertSRT(text)
		}
		w.Header().Set("content-type", "text/vtt; charset=utf-8")
		w.Header().Set("cache-control", "public, max-age=86400")
		_, _ = io.WriteString(w, text)
		return
	}

	if rewrite && method != http.MethodHead {
		if isPlaylist {
			text, err := io.ReadAll(io.LimitReader(response.Body, maxBody))
			if err != nil {
				notFound(w)
				return
			}
			rewritten := RewritePlaylist(string(text), target.String(), base, payload.Headers)
			w.Header().Set("content-type", "application/vnd.apple.mpegurl")
			w.Header().Set("cache-control", "public, max-age=5")
			_, _ = io.WriteString(w, rewritten)
			return
		}
		// Sniff unknown payloads: an m3u8 served as image/jpeg or
		// octet-stream must still be rewritten, or the player resolves its
		// child URLs against the relay and 404s.
		head, err := io.ReadAll(io.LimitReader(response.Body, 16))
		if err == nil && strings.HasPrefix(strings.TrimSpace(string(head)), "#EXTM3U") {
			rest, readErr := io.ReadAll(io.LimitReader(response.Body, maxBody))
			if readErr != nil {
				notFound(w)
				return
			}
			rewritten := RewritePlaylist(string(head)+string(rest), target.String(), base, payload.Headers)
			w.Header().Set("content-type", "application/vnd.apple.mpegurl")
			w.Header().Set("cache-control", "public, max-age=5")
			_, _ = io.WriteString(w, rewritten)
			return
		}
		response.Body = io.NopCloser(io.MultiReader(strings.NewReader(string(head)), response.Body))
	}

	for _, name := range forwardHeaders {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}

	if cacheKey != "" && response.StatusCode == http.StatusOK && method != http.MethodHead {
		effectiveTTL := defaultTTL(contentType)
		if ttlSet {
			effectiveTTL = ttl
		}
		length, _ := strconv.ParseInt(response.Header.Get("content-length"), 10, 64)
		if effectiveTTL > 0 && (length <= 0 || length <= maxBody) {
			data, err := io.ReadAll(io.LimitReader(response.Body, maxBody))
			if err == nil {
				r.cache.Put(cacheKey, contentType, data, effectiveTTL)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(data)
				return
			}
		}
	}

	w.WriteHeader(response.StatusCode)
	if method != http.MethodHead {
		_, _ = io.Copy(w, response.Body)
	}
}

func (r *Relay) cacheEnabled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.enabled && r.cache != nil
}

func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func cacheableURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	query := parsed.Query()
	for _, param := range volatileParams {
		query.Del(param)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func wantsRewrite(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return typed == "1" || typed == "true"
	case float64:
		return typed == 1
	}
	return false
}

func parseTTL(value any) (time.Duration, bool) {
	if value == nil || value == "" {
		return 0, false
	}
	var seconds int
	switch typed := value.(type) {
	case float64:
		seconds = int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err != nil {
			return -1, true
		}
		seconds = parsed
	default:
		return -1, true
	}
	if seconds < 0 {
		return -1, true
	}
	if seconds > 86400 {
		seconds = 86400
	}
	return time.Duration(seconds) * time.Second, true
}

func defaultTTL(contentType string) time.Duration {
	value := strings.ToLower(contentType)
	switch {
	case strings.Contains(value, "mpegurl"):
		return 5 * time.Second
	case strings.HasPrefix(value, "video/"),
		strings.HasPrefix(value, "audio/"),
		strings.HasPrefix(value, "image/"),
		strings.Contains(value, "vnd.apple"),
		strings.Contains(value, "octet-stream"),
		strings.Contains(value, "text/vtt"):
		return 24 * time.Hour
	case strings.Contains(value, "json"):
		return 30 * time.Second
	}
	return 0
}

// looksLikeSubtitle reports whether a response is a subtitle file: by its
// content type, or by an .srt/.vtt/.ass extension on the upstream path.
func looksLikeSubtitle(contentType, targetPath string) bool {
	lower := strings.ToLower(contentType)
	if strings.Contains(lower, "text/vtt") || strings.Contains(lower, "x-subrip") ||
		strings.Contains(lower, "subrip") || strings.Contains(lower, "text/plain") && subtitleExt.MatchString(targetPath) {
		return true
	}
	return subtitleExt.MatchString(targetPath)
}

var subtitleExt = regexp.MustCompile(`(?i)\.(srt|vtt|ass|ssa)(\?|$)`)

func setCORS(w http.ResponseWriter) {
	w.Header().Set("access-control-allow-origin", "*")
	w.Header().Set("access-control-allow-methods", "GET, POST, HEAD, OPTIONS")
	w.Header().Set("access-control-allow-headers", "*")
	w.Header().Set("access-control-expose-headers", "content-type, content-range, accept-ranges, cache-control")
}

func notFound(w http.ResponseWriter) {
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, "404")
}

// RewritePlaylist points every URI in a playlist back through the local relay.
func RewritePlaylist(text, target, endpoint string, headers json.RawMessage) string {
	headersParam := ""
	if len(headers) > 0 && string(headers) != "null" && string(headers) != `""` {
		headersParam = string(headers)
	}
	proxify := func(raw string) string {
		absolute, err := resolveReference(target, raw)
		if err != nil {
			return raw
		}
		query := url.Values{}
		query.Set("url", absolute)
		query.Set("rewrite", "1")
		if headersParam != "" {
			query.Set("headers", headersParam)
		}
		return endpoint + "/?" + query.Encode()
	}

	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			lines[index] = uriPattern.ReplaceAllStringFunc(line, func(match string) string {
				sub := uriPattern.FindStringSubmatch(match)
				if len(sub) < 2 {
					return match
				}
				return `URI="` + proxify(sub[1]) + `"`
			})
			continue
		}
		lines[index] = proxify(trimmed)
	}
	return strings.Join(lines, "\n")
}

var uriPattern = regexp.MustCompile(`URI="([^"]+)"`)

func resolveReference(base, reference string) (string, error) {
	baseURL, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(strings.TrimSpace(reference))
	if err != nil {
		return "", err
	}
	return baseURL.ResolveReference(ref).String(), nil
}
