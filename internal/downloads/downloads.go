package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"twisted/internal/megaplay"
	"twisted/internal/providers"
)

type Status string

const (
	StatusQueued      Status = "queued"
	StatusDownloading Status = "downloading"
	StatusPaused      Status = "paused"
	StatusComplete    Status = "complete"
	StatusFailed      Status = "failed"
)

type Item struct {
	ID            string `json:"id"`
	MalID         int    `json:"malId"`
	Slug          string `json:"slug"`
	Title         string `json:"title"`
	Poster        string `json:"poster"`
	EpisodeThumb  string `json:"episodeThumb"`
	LocalPoster   string `json:"localPoster"`
	LocalThumb    string `json:"localThumb"`
	Year          int    `json:"year"`
	TotalEpisodes int    `json:"totalEpisodes"`
	Episode       int    `json:"episode"`
	Kind          string `json:"kind"`
	Quality       string `json:"quality"`
	Status        Status `json:"status"`
	Bytes         int64  `json:"bytes"`
	/** Total size advertised by the playlist, when known (0 otherwise). */
	Expected      int64  `json:"expectedBytes"`
	Segments      int    `json:"segments"`
	Done          int    `json:"done"`
	Error         string `json:"error"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
	Dir           string `json:"-"`
}

type job struct {
	cancel context.CancelFunc
}

type Manager struct {
	mu       sync.Mutex
	root     string
	items    map[string]*Item
	queue    chan string
	wakeup   chan struct{}
	workers  int
	resolver *megaplay.Resolver
	client   *http.Client
	closed   chan struct{}
	once     sync.Once
	// Provider preference and per-provider server choice, pushed by the UI.
	preferProvider []string
	serverFor      func(string) string
	// Provider of the episode being fetched (for its headers).
	streamReferer string
	streamOrigin  string
	// Torrent (Kuma) downloader: writes a finished HLS episode into a folder.
	kumaDownload func(ctx context.Context, malID, episode int, kind, dir string) error
	// onChange is called (outside the lock) whenever an item's visible state
	// changes, so the UI can be pushed instead of polling.
	onChange func(Item)
}

// SetKumaDownloader wires the torrent engine in as another download source.
func (m *Manager) SetKumaDownloader(downloader func(ctx context.Context, malID, episode int, kind, dir string) error) {
	m.mu.Lock()
	m.kumaDownload = downloader
	m.mu.Unlock()
}

// SetProviderChoice selects which mirror downloads use, and which sub-server
// it should ask for. Both are optional: the registry falls back to its order.
func (m *Manager) SetProviderChoice(preferred []string, serverFor func(string) string) {
	m.mu.Lock()
	m.preferProvider = preferred
	m.serverFor = serverFor
	m.mu.Unlock()
}

// playlistText fetches an HLS playlist with the current provider's headers.
func (m *Manager) playlistText(ctx context.Context, target string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	m.mu.Lock()
	referer, origin := m.streamReferer, m.streamOrigin
	m.mu.Unlock()
	if referer != "" {
		req.Header.Set("referer", referer)
	}
	if origin != "" {
		req.Header.Set("origin", origin)
	}
	res, err := m.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("playlist HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetChangeHandler wires progress/status notifications to the desktop layer.
func (m *Manager) SetChangeHandler(handler func(Item)) {
	m.mu.Lock()
	m.onChange = handler
	m.mu.Unlock()
}

// notify publishes the current state of one item.
func (m *Manager) notify(id string) {
	m.mu.Lock()
	item := m.items[id]
	var copied Item
	if item != nil {
		copied = *item
	}
	handler := m.onChange
	m.mu.Unlock()
	if item != nil && handler != nil {
		handler(copied)
	}
}

func New(root string) *Manager {
	manager := &Manager{
		root:     root,
		items:    map[string]*Item{},
		queue:    make(chan string, 512),
		wakeup:   make(chan struct{}, 64),
		workers:  2,
		resolver: megaplay.New(),
		client: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:          64,
				IdleConnTimeout:       60 * time.Second,
				ResponseHeaderTimeout: 30 * time.Second,
			},
		},
		closed: make(chan struct{}),
	}
	_ = os.MkdirAll(root, 0o755)
	manager.load()
	for range manager.workers {
		go manager.worker()
	}
	return manager
}

func (m *Manager) SetConcurrency(count int) {
	if count < 1 {
		count = 1
	}
	if count > 6 {
		count = 6
	}
	m.mu.Lock()
	m.workers = count
	m.mu.Unlock()
}

func (m *Manager) SetRoot(root string) {
	if root == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if root == m.root {
		return
	}
	m.root = root
	_ = os.MkdirAll(root, 0o755)
	for id, item := range m.items {
		item.Dir = filepath.Join(root, id)
	}
}

func (m *Manager) Shutdown() {
	m.once.Do(func() {
		close(m.closed)
		m.mu.Lock()
		for id := range m.items {
			if cancel := m.cancelFor(id); cancel != nil {
				cancel()
			}
		}
		m.mu.Unlock()
	})
}

// cancel is stored on the item through this side table so Item stays JSON-clean.
var cancels sync.Map

func (m *Manager) setCancel(id string, cancel context.CancelFunc) {
	if cancel == nil {
		cancels.Delete(id)
		return
	}
	cancels.Store(id, cancel)
}

func (m *Manager) cancelFor(id string) context.CancelFunc {
	if value, ok := cancels.Load(id); ok {
		return value.(context.CancelFunc)
	}
	return nil
}

func (m *Manager) load() {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(m.root, entry.Name())
		data, err := os.ReadFile(filepath.Join(dir, "item.json"))
		if err != nil {
			continue
		}
		var item Item
		if json.Unmarshal(data, &item) != nil {
			continue
		}
		if item.ID == "" {
			item.ID = entry.Name()
		}
		if item.Status == StatusDownloading || item.Status == StatusQueued {
			item.Status = StatusPaused
		}
		item.Dir = dir
		m.items[item.ID] = &item
	}
}

func (m *Manager) persist(item *Item) {
	_ = os.MkdirAll(item.Dir, 0o755)
	data, err := json.MarshalIndent(item, "", "  ")
	if err == nil {
		_ = os.WriteFile(filepath.Join(item.Dir, "item.json"), data, 0o644)
	}
}

func (m *Manager) List() []Item {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := make([]Item, 0, len(m.items))
	for _, item := range m.items {
		items = append(items, *item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].Episode < items[j].Episode
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	return items
}

var unsafeChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func idFor(slug string, episode int, kind string) string {
	cleaned := strings.Trim(unsafeChars.ReplaceAllString(slug, "-"), "-")
	if cleaned == "" {
		cleaned = "title"
	}
	return fmt.Sprintf("%s-e%04d-%s", cleaned, episode, kind)
}

func (m *Manager) Add(request Item) (Item, error) {
	if request.MalID <= 0 || request.Episode <= 0 {
		return Item{}, errors.New("invalid episode")
	}
	kind := megaplay.NormalizeKind(request.Kind)
	id := idFor(request.Slug, request.Episode, kind)

	m.mu.Lock()
	if existing, ok := m.items[id]; ok {
		copied := *existing
		m.mu.Unlock()
		if copied.Status == StatusPaused || copied.Status == StatusFailed {
			return m.Resume(id)
		}
		return copied, nil
	}
	now := time.Now().Unix()
	item := &Item{
		ID:            id,
		MalID:         request.MalID,
		Slug:          request.Slug,
		Title:         request.Title,
		Poster:        request.Poster,
		EpisodeThumb:  request.EpisodeThumb,
		Year:          request.Year,
		TotalEpisodes: request.TotalEpisodes,
		Episode:       request.Episode,
		Kind:          kind,
		Quality:       request.Quality,
		Status:        StatusQueued,
		CreatedAt:     now,
		UpdatedAt:     now,
		Dir:           filepath.Join(m.root, id),
	}
	m.items[id] = item
	m.persist(item)
	copied := *item
	m.mu.Unlock()

	m.enqueue(id)
	return copied, nil
}

func (m *Manager) enqueue(id string) {
	select {
	case m.queue <- id:
	default:
	}
	select {
	case m.wakeup <- struct{}{}:
	default:
	}
}

func (m *Manager) Pause(id string) (Item, error) {
	m.mu.Lock()
	item, ok := m.items[id]
	if !ok {
		m.mu.Unlock()
		return Item{}, errors.New("download not found")
	}
	item.Status = StatusPaused
	item.UpdatedAt = time.Now().Unix()
	m.persist(item)
	copied := *item
	m.mu.Unlock()

	// Cancel first so in-flight segment requests stop, then publish: the UI
	// shows "Paused" immediately instead of waiting for the worker to unwind.
	if cancel := m.cancelFor(id); cancel != nil {
		cancel()
	}
	m.notify(id)
	return copied, nil
}

func (m *Manager) Resume(id string) (Item, error) {
	m.mu.Lock()
	item, ok := m.items[id]
	if !ok {
		m.mu.Unlock()
		return Item{}, errors.New("download not found")
	}
	if item.Status == StatusComplete {
		copied := *item
		m.mu.Unlock()
		return copied, nil
	}
	item.Status = StatusQueued
	item.Error = ""
	item.UpdatedAt = time.Now().Unix()
	m.persist(item)
	copied := *item
	m.mu.Unlock()

	m.notify(id)
	m.enqueue(id)
	return copied, nil
}

func (m *Manager) Retry(id string) (Item, error) {
	return m.Resume(id)
}

func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	item, ok := m.items[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("download not found")
	}
	delete(m.items, id)
	m.mu.Unlock()

	if cancel := m.cancelFor(id); cancel != nil {
		cancel()
	}
	m.setCancel(id, nil)
	return os.RemoveAll(item.Dir)
}

func (m *Manager) worker() {
	for {
		select {
		case <-m.closed:
			return
		case <-m.wakeup:
			select {
			case id := <-m.queue:
				m.run(id)
			default:
			}
		}
	}
}

func (m *Manager) run(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	m.setCancel(id, cancel)

	m.mu.Lock()
	item, ok := m.items[id]
	if !ok || item.Status != StatusQueued {
		m.mu.Unlock()
		cancel()
		m.setCancel(id, nil)
		return
	}
	item.Status = StatusDownloading
	item.UpdatedAt = time.Now().Unix()
	m.persist(item)
	m.mu.Unlock()
	m.notify(id)

	err := m.download(ctx, id)
	wasCancelled := ctx.Err() != nil
	cancel()
	m.setCancel(id, nil)

	m.mu.Lock()
	item, ok = m.items[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	switch {
	case item.Status == StatusPaused:
		// already handled
	case err != nil && wasCancelled:
		item.Status = StatusPaused
	case err != nil:
		item.Status = StatusFailed
		item.Error = err.Error()
	default:
		item.Status = StatusComplete
		item.Error = ""
	}
	item.UpdatedAt = time.Now().Unix()
	m.persist(item)
	m.mu.Unlock()
	m.notify(id)
}

type plan struct {
	source   *megaplay.Source
	lines    []string
	base     string
	segments []string
	keys     []string
}

func (m *Manager) download(ctx context.Context, id string) error {
	m.mu.Lock()
	item := m.items[id]
	if item == nil {
		m.mu.Unlock()
		return errors.New("download not found")
	}
	malID, episode := item.MalID, item.Episode
	kind, quality, dir := item.Kind, item.Quality, item.Dir
	kumaDownloader := m.kumaDownload
	provider := ""
	if len(m.preferProvider) > 0 {
		provider = m.preferProvider[0]
	}
	m.mu.Unlock()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// Kuma writes a finished HLS episode through the torrent engine instead of
	// fetching segments itself.
	if provider == "kuma" && kumaDownloader != nil {
		if err := kumaDownloader(ctx, malID, episode, kind, dir); err != nil {
			return err
		}
		return m.finishKumaDownload(id, dir, malID, episode, kind)
	}

	source, err := providers.Resolve(ctx, m.preferProvider, malID, episode, kind, m.serverFor)
	if err != nil {
		if providers.IsNotFound(err) {
			return errors.New("this episode is not available")
		}
		return err
	}

	m.mu.Lock()
	m.streamReferer, m.streamOrigin = source.Referer, source.Origin
	m.mu.Unlock()

	masterText, err := m.playlistText(ctx, source.URL)
	if err != nil {
		return err
	}

	base := source.URL
	mediaText := masterText
	if variants := megaplay.ParseMaster(masterText, source.URL); len(variants) > 0 {
		variant := megaplay.PickVariant(variants, quality)
		if variant == nil {
			return errors.New("no playable rendition")
		}
		mediaText, err = m.playlistText(ctx, variant.URL)
		if err != nil {
			return err
		}
		base = variant.URL
	}

	media, err := parseMedia(mediaText, base)
	if err != nil {
		return err
	}

	// A fresh CDN token is needed for long episodes: the signed playlist url
	// expires after ~90s and segment fetches past that point get 403s. Only
	// megaplay's CDN uses signed paths; other providers pass through unchanged.
	if refreshed, err := megaplay.SignWith(base, source.URL, 10*time.Minute); err == nil {
		if text, fetchErr := m.playlistText(ctx, refreshed); fetchErr == nil {
			if again, parseErr := parseMedia(text, refreshed); parseErr == nil {
				media = again
				base = refreshed
			}
		}
	}

	m.mu.Lock()
	if current := m.items[id]; current != nil {
		current.Segments = len(media.segments)
		current.Done = 0
		current.Bytes = 0
		var expected int64
		for _, size := range media.sizes {
			expected += size
		}
		current.Expected = expected
		m.persist(current)
	}
	m.mu.Unlock()
	m.notify(id)

	if err := os.MkdirAll(filepath.Join(dir, "segments"), 0o755); err != nil {
		return err
	}

	names := make(map[string]string, len(media.segments))
	for index, segment := range media.segments {
		if _, ok := names[segment]; ok {
			continue
		}
		names[segment] = fmt.Sprintf("segments/%04d.ts", index)
	}

	if err := m.fetchSegments(ctx, id, dir, media.segments, names, source); err != nil {
		return err
	}

	local := rewritePlaylist(media.lines, base, names)
	if err := os.WriteFile(filepath.Join(dir, "playlist.m3u8"), []byte(local), 0o644); err != nil {
		return err
	}
	tracks := make([]providers.Track, 0, len(source.Tracks))
	for _, track := range source.Tracks {
		localTrack, err := m.downloadSubtitle(ctx, dir, track, source)
		if err == nil {
			tracks = append(tracks, localTrack)
		}
	}

	metadata := map[string]any{
		"malId":      malID,
		"episode":    episode,
		"kind":       kind,
		"provider":   source.Provider,
		"server":     source.Server,
		"intro":      source.Intro,
		"outro":      source.Outro,
		"tracks":     tracks,
		"downloaded": time.Now().Unix(),
		// Where the local playlist lives, so external players open the file
		// (with its relative segment paths) rather than a relative URL.
		"playlist": "playlist.m3u8",
	}
	if data, err := json.MarshalIndent(metadata, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "stream.json"), data, 0o644)
	}

	// Keep the artwork on disk too so the downloads page still has covers and
	// episode stills with no network.
	m.mu.Lock()
	poster, thumb := "", ""
	if current := m.items[id]; current != nil {
		poster, thumb = current.Poster, current.EpisodeThumb
	}
	m.mu.Unlock()

	localPoster, localThumb := "", ""
	if poster != "" {
		if err := m.cacheImage(ctx, dir, "poster", poster); err == nil {
			localPoster = "poster.img"
		}
	}
	if thumb != "" {
		if err := m.cacheImage(ctx, dir, "thumb", thumb); err == nil {
			localThumb = "thumb.img"
		}
	}

	m.mu.Lock()
	if current := m.items[id]; current != nil {
		current.LocalPoster = localPoster
		current.LocalThumb = localThumb
		current.UpdatedAt = time.Now().Unix()
		m.persist(current)
	}
	m.mu.Unlock()
	return nil
}

// finishKumaDownload records metadata and artwork for a torrent download.
func (m *Manager) finishKumaDownload(id, dir string, malID, episode int, kind string) error {
	metadata := map[string]any{
		"malId":      malID,
		"episode":    episode,
		"kind":       kind,
		"provider":   "kuma",
		"downloaded": time.Now().Unix(),
		"playlist":   "playlist.m3u8",
	}
	if data, err := json.MarshalIndent(metadata, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "stream.json"), data, 0o644)
	}

	m.mu.Lock()
	poster, thumb := "", ""
	if current := m.items[id]; current != nil {
		poster, thumb = current.Poster, current.EpisodeThumb
	}
	m.mu.Unlock()

	localPoster, localThumb := "", ""
	if poster != "" {
		if err := m.cacheImage(context.Background(), dir, "poster", poster); err == nil {
			localPoster = "poster.img"
		}
	}
	if thumb != "" {
		if err := m.cacheImage(context.Background(), dir, "thumb", thumb); err == nil {
			localThumb = "thumb.img"
		}
	}

	m.mu.Lock()
	if current := m.items[id]; current != nil {
		current.LocalPoster = localPoster
		current.LocalThumb = localThumb
		current.UpdatedAt = time.Now().Unix()
		m.persist(current)
	}
	m.mu.Unlock()
	return nil
}

// cacheImage stores a remote artwork file inside the download directory.
func (m *Manager) cacheImage(ctx context.Context, dir, name, target string) error {
	if _, err := fetchToFile(ctx, m.client, target, filepath.Join(dir, name+".img"), map[string]string{}); err != nil {
		return err
	}
	return nil
}

func (m *Manager) fetchSegments(
	ctx context.Context,
	id, dir string,
	segments []string,
	names map[string]string,
	source *providers.Stream,
) error {
	headers := map[string]string{
		"referer": "https://megaplay.buzz/",
		"origin":  "https://megaplay.buzz",
	}
	if source != nil && source.Referer != "" {
		headers = map[string]string{"referer": source.Referer}
		if source.Origin != "" {
			headers["origin"] = source.Origin
		}
	}
	unique := make([]string, 0, len(segments))
	seen := map[string]bool{}
	for _, segment := range segments {
		if seen[segment] {
			continue
		}
		seen[segment] = true
		unique = append(unique, segment)
	}

	semaphore := make(chan struct{}, 4)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for _, segment := range unique {
		if ctx.Err() != nil {
			break
		}
		destination := filepath.Join(dir, names[segment])
		if info, err := os.Stat(destination); err == nil && info.Size() > 0 {
			continue
		}
		wg.Add(1)
		semaphore <- struct{}{}
		go func(target, path string) {
			defer wg.Done()
			defer func() { <-semaphore }()
			if ctx.Err() != nil {
				return
			}
			// CDN segments occasionally drop one connection; retry before giving
			// up, otherwise a fully fetched episode would still report failure.
			var size int64
			var err error
			for attempt := 0; attempt < 4; attempt++ {
				if ctx.Err() != nil {
					return
				}
				size, err = fetchToFile(ctx, m.client, target, path, headers)
				if err == nil {
					break
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(attempt+1) * 400 * time.Millisecond):
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			m.mu.Lock()
			if item := m.items[id]; item != nil {
				item.Bytes += size
				item.Done++
				item.UpdatedAt = time.Now().Unix()
				m.persist(item)
			}
			m.mu.Unlock()
			m.notify(id)
		}(segment, destination)
	}
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	return ctx.Err()
}

func (m *Manager) downloadSubtitle(
	ctx context.Context,
	dir string,
	track providers.Track,
	source *providers.Stream,
) (providers.Track, error) {
	if track.URL == "" {
		return track, errors.New("no subtitle")
	}
	subtitleDir := filepath.Join(dir, "subtitles")
	if err := os.MkdirAll(subtitleDir, 0o755); err != nil {
		return track, err
	}
	extension := filepath.Ext(track.URL)
	if extension == "" || len(extension) > 6 {
		extension = ".vtt"
	}
	name := unsafeChars.ReplaceAllString(track.Label, "-")
	if name == "" {
		name = "subtitle"
	}
	fileName := name + extension
	headers := map[string]string{"referer": "https://megaplay.buzz/"}
	if source != nil && source.Referer != "" {
		headers["referer"] = source.Referer
	}
	if _, err := fetchToFile(ctx, m.client, track.URL, filepath.Join(subtitleDir, fileName), headers); err != nil {
		return track, err
	}
	track.File = "subtitles/" + fileName
	return track, nil
}

type media struct {
	lines    []string
	segments []string
	// sizes maps segment URL -> advertised length in bytes (0 when the
	// playlist does not say), used for the MB estimate before the fetch.
	sizes map[string]int64
}

func parseMedia(text, base string) (*media, error) {
	result := &media{
		lines: strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n"),
		sizes: map[string]int64{},
	}
	pendingSize := int64(0)
	for _, line := range result.lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#EXTINF:") {
			continue
		}
		if strings.HasPrefix(trimmed, "#EXT-X-BYTERANGE:") {
			// #EXT-X-BYTERANGE:<length>[@<offset>]
			value := strings.TrimPrefix(trimmed, "#EXT-X-BYTERANGE:")
			if at := strings.Index(value, "@"); at >= 0 {
				value = value[:at]
			}
			if length, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil {
				pendingSize = length
			}
			continue
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		absolute, err := resolveReference(base, trimmed)
		if err != nil {
			continue
		}
		result.segments = append(result.segments, absolute)
		if pendingSize > 0 {
			result.sizes[absolute] = pendingSize
		}
		pendingSize = 0
	}
	if len(result.segments) == 0 {
		return nil, errors.New("playlist has no segments")
	}
	return result, nil
}

func rewritePlaylist(lines []string, base string, names map[string]string) string {
	out := make([]string, 0, len(lines))
	keyPattern := regexp.MustCompile(`URI="([^"]+)"`)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			out = append(out, line)
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			out = append(out, keyPattern.ReplaceAllStringFunc(line, func(match string) string {
				sub := keyPattern.FindStringSubmatch(match)
				if len(sub) < 2 {
					return match
				}
				return `URI="` + sub[1] + `"`
			}))
			continue
		}
		absolute, err := resolveReference(base, trimmed)
		if err != nil {
			out = append(out, line)
			continue
		}
		if local, ok := names[absolute]; ok {
			out = append(out, local)
		} else {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

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

func fetchToFile(ctx context.Context, client *http.Client, target, destination string, headers map[string]string) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return 0, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return 0, err
	}
	temp := destination + ".part"
	file, err := os.Create(temp)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(file, response.Body)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(temp)
		return 0, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temp)
		return 0, closeErr
	}
	if err := os.Rename(temp, destination); err != nil {
		return 0, err
	}
	return written, nil
}

func (m *Manager) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	relative := strings.TrimPrefix(req.URL.Path, "/downloads/")
	if relative == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	cleaned := filepath.Clean("/" + relative)
	parts := strings.SplitN(strings.TrimPrefix(cleaned, "/"), "/", 2)
	id := parts[0]
	rest := ""
	if len(parts) > 1 {
		rest = parts[1]
	}

	m.mu.Lock()
	item := m.items[id]
	root := m.root
	m.mu.Unlock()
	if item == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	dir := item.Dir
	if dir == "" {
		dir = filepath.Join(root, id)
	}
	baseDir, err := filepath.Abs(dir)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	target, err := filepath.Abs(filepath.Join(baseDir, rest))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if target != baseDir && !strings.HasPrefix(target, baseDir+string(os.PathSeparator)) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("access-control-allow-origin", "*")
	if strings.HasSuffix(target, ".img") {
		// Artwork is stored with a neutral extension; sniff the real type.
		if file, err := os.Open(target); err == nil {
			head := make([]byte, 512)
			n, _ := file.Read(head)
			file.Close()
			w.Header().Set("content-type", http.DetectContentType(head[:n]))
		}
	}
	http.ServeFile(w, req, target)
}

func (m *Manager) PlayURL(id string) string {
	return "/downloads/" + id + "/playlist.m3u8"
}

// Dir returns the folder holding one download's files.
func (m *Manager) Dir(id string) (string, error) {
	m.mu.Lock()
	item := m.items[id]
	root := m.root
	m.mu.Unlock()
	if item == nil {
		return "", errors.New("download not found")
	}
	if item.Dir != "" {
		return item.Dir, nil
	}
	return filepath.Join(root, id), nil
}

func (m *Manager) Metadata(id string) (map[string]any, error) {
	m.mu.Lock()
	item := m.items[id]
	root := m.root
	m.mu.Unlock()
	if item == nil {
		return nil, errors.New("download not found")
	}
	dir := item.Dir
	if dir == "" {
		dir = filepath.Join(root, id)
	}
	data, err := os.ReadFile(filepath.Join(dir, "stream.json"))
	if err != nil {
		return nil, err
	}
	var metadata map[string]any
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, err
	}
	return metadata, nil
}
