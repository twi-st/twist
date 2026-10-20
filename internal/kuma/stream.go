package kuma

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
)

// Stream is a running torrent→HLS session for one episode. ffmpeg reads the
// selected file straight from the torrent (it blocks until pieces arrive) and
// writes an HLS ladder into a local directory, which the app's relay serves to
// the built-in player like any other source.
type Stream struct {
	mu       sync.Mutex
	engine   *Engine
	id       string
	torrent  *torrent.Torrent
	file     *torrent.File
	dir      string
	playlist string
	writer   *playlistWriter
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	done     chan struct{}
	err      error
	width    int
	height   int
	audio    int
	started  time.Time
}

// StreamInfo is the public view of a running session.
type StreamInfo struct {
	ID       string `json:"id"`
	Dir      string `json:"dir"`
	Playlist string `json:"playlist"`
	Title    string `json:"title"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Done     bool   `json:"done"`
	Error    string `json:"error,omitempty"`
}

// Engine owns the torrent client and the active sessions.
type Engine struct {
	mu       sync.Mutex
	client   *torrent.Client
	settings Settings
	ffmpeg   FFmpegStatus
	streams  map[string]*Stream
}

// NewEngine starts a torrent client in the configured cache directory.
func NewEngine(settings Settings) (*Engine, error) {
	ffmpeg := FFmpegPath(settings)
	if !ffmpeg.Available {
		return nil, errors.New("ffmpeg is required for torrent playback")
	}
	if err := os.MkdirAll(settings.CacheDir, 0o755); err != nil {
		return nil, err
	}

	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = settings.CacheDir
	// We never upload, so all bandwidth goes to fetching the episode.
	cfg.NoUpload = true
	cfg.Seed = false
	cfg.ListenPort = settings.ListenPort
	// More peers in parallel is the single biggest speed factor for a
	// swarm with hundreds of seeders.
	cfg.EstablishedConnsPerTorrent = 120
	cfg.HalfOpenConnsPerTorrent = 60
	cfg.TorrentPeersHighWater = 800
	// Let the client ask the router for an inbound port; without it most
	// peers can only be reached outbound and the swarm crawls.
	cfg.NoDefaultPortForwarding = false
	cfg.NoDHT = false
	cfg.DisablePEX = false
	client, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	return &Engine{
		client:   client,
		settings: settings,
		ffmpeg:   ffmpeg,
		streams:  map[string]*Stream{},
	}, nil
}

// FFmpeg reports the ffmpeg used by the engine.
func (e *Engine) FFmpeg() FFmpegStatus { return e.ffmpeg }

// Close stops every session and the torrent client.
func (e *Engine) Close() {
	e.mu.Lock()
	streams := make([]*Stream, 0, len(e.streams))
	for _, stream := range e.streams {
		streams = append(streams, stream)
	}
	e.streams = map[string]*Stream{}
	client := e.client
	e.client = nil
	e.mu.Unlock()

	for _, stream := range streams {
		stream.stop()
	}
	if client != nil {
		client.Close()
	}
}

// Start opens a torrent session for one candidate and returns once ffmpeg has
// produced a playable playlist.
func (e *Engine) Start(ctx context.Context, id string, candidate Candidate, kind string, segmentSeconds int) (*StreamInfo, error) {
	e.mu.Lock()
	client := e.client
	settings := e.settings
	existing := e.streams[id]
	e.mu.Unlock()
	if client == nil {
		return nil, errors.New("torrent engine is closed")
	}
	if existing != nil {
		return existing.info(), nil
	}
	if segmentSeconds < 2 || segmentSeconds > 20 {
		segmentSeconds = settings.SegmentSeconds
	}

	spec, err := torrentSpec(buildMagnet(candidate), candidate.Trackers)
	if err != nil {
		return nil, err
	}
	// No upload, but peers still need to see us as a leech.
	t, _, err := client.AddTorrentSpec(spec)
	if err != nil {
		return nil, err
	}

	// Metadata (file list) can take a while on a cold DHT.
	select {
	case <-t.GotInfo():
	case <-ctx.Done():
		t.Drop()
		return nil, ctx.Err()
	case <-time.After(90 * time.Second):
		t.Drop()
		return nil, errors.New("timed out waiting for torrent metadata")
	}

	file, err := pickFile(t, candidate.FileIdx)
	if err != nil {
		t.Drop()
		return nil, err
	}
	file.Download()
	prioritizeStart(t, file)

	dir := filepath.Join(settings.CacheDir, "hls", sanitize(id))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Drop()
		return nil, err
	}

	runCtx, cancel := context.WithCancel(context.Background())
	stream := &Stream{
		engine:  e,
		id:      id,
		torrent: t,
		file:    file,
		dir:     dir,
		done:    make(chan struct{}),
		cancel:  cancel,
		started: time.Now(),
	}

	// ffmpeg reads the torrent through a local HTTP endpoint, which lets it
	// seek freely (needed for the player's scrubbing) without copying the file.
	readerURL, err := e.serveFile(runCtx, stream)
	if err != nil {
		cancel()
		t.Drop()
		return nil, err
	}

	// The episode is presented as a finished video: probe the duration from the
	// torrent header, then publish a complete VOD playlist (with ENDLIST) before
	// playback starts. Segments that are still downloading are waited for by the
	// segment handler, so the player sees a normal episode with its real length
	// instead of a live stream.
	duration, _ := probeDuration(runCtx, e.ffmpeg.Path, readerURL, 45*time.Second)

	// Dual-audio releases carry both tracks; mux the one the viewer asked for
	// rather than always the first (which is usually the original Japanese).
	audio := pickAudio(probeAudio(runCtx, e.ffmpeg.Path, readerURL, 45*time.Second), kind)
	stream.audio = audio

	// ffmpeg only writes segments; the watcher publishes the playlist.
	cmd := ffmpegSegmentCommand(runCtx, e.ffmpeg.Path, readerURL, dir, segmentSeconds, audio)
	// Keep the tail of ffmpeg's stderr so a failed start can say why.
	logTail := &tailWriter{limit: 4096}
	cmd.Stderr = logTail
	stream.cmd = cmd
	if err := cmd.Start(); err != nil {
		cancel()
		t.Drop()
		return nil, err
	}
	stream.playlist = filepath.Join(dir, "index.m3u8")
	writer := newPlaylistWriter(dir, segmentSeconds, duration)
	stream.writer = writer
	go writer.Watch(runCtx, filepath.Join(dir, "ffmpeg.m3u8"))

	e.mu.Lock()
	e.streams[id] = stream
	e.mu.Unlock()

	go func() {
		err := cmd.Wait()
		stream.mu.Lock()
		if err != nil && runCtx.Err() == nil {
			stream.err = err
		}
		stream.mu.Unlock()
		close(stream.done)
	}()

	// Wait for the playlist to be published (the full VOD list when the
	// duration was probed) before handing the URL to the player.
	// A cold swarm can take a while; the player shows a loading state meanwhile.
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(stream.playlist); err == nil {
			if size, _ := fileSize(stream.playlist); size > 64 {
				return stream.info(), nil
			}
		}
		select {
		case <-runCtx.Done():
			return nil, errors.New("torrent stream stopped")
		case <-stream.done:
			stream.mu.Lock()
			err := stream.err
			stream.mu.Unlock()
			if err == nil {
				err = errors.New("ffmpeg stopped before producing a playlist")
			}
			if tail := strings.TrimSpace(logTail.String()); tail != "" {
				err = fmt.Errorf("%w: %s", err, lastLines(tail, 3))
			}
			e.Stop(id)
			return nil, err
		case <-time.After(250 * time.Millisecond):
		}
	}
	e.Stop(id)
	return nil, errors.New("torrent is too slow to start (no peers?)")
}

// serveFile exposes the torrent file over loopback so ffmpeg can seek in it.
func (e *Engine) serveFile(ctx context.Context, stream *Stream) (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reader := stream.file.NewReader()
		defer reader.Close()
		// ffmpeg reads sequentially; a generous readahead keeps it from
		// stalling every few hundred kilobytes waiting on piece requests.
		reader.SetReadahead(16 << 20)
		reader.SetContext(r.Context())
		http.ServeContent(w, r, stream.file.DisplayPath(), time.Time{}, reader)
	})}
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	go func() {
		_ = server.Serve(listener)
	}()
	return "http://" + listener.Addr().String() + "/stream", nil
}

// Stop ends one session and removes its temporary HLS files.
func (e *Engine) Stop(id string) {
	e.mu.Lock()
	stream := e.streams[id]
	delete(e.streams, id)
	e.mu.Unlock()
	if stream != nil {
		stream.stop()
	}
}

func (s *Stream) stop() {
	s.cancel()
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		if s.cmd.ProcessState == nil {
			_, _ = s.cmd.Process.Wait()
		}
	}
	// Give the in-flight HTTP reader a moment to observe the cancelled
	// request before the torrent is dropped (otherwise the client logs
	// "torrent closed" reader errors).
	time.Sleep(150 * time.Millisecond)
	if s.torrent != nil {
		s.torrent.Drop()
	}
	// The HLS directory is disposable; keep it only while ffmpeg might still
	// be reading (the process is killed above).
	_ = os.RemoveAll(s.dir)
}

func (s *Stream) info() *StreamInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := &StreamInfo{
		ID:       s.id,
		Dir:      s.dir,
		Playlist: s.playlist,
		Width:    s.width,
		Height:   s.height,
	}
	if s.err != nil {
		info.Error = s.err.Error()
	}
	select {
	case <-s.done:
		info.Done = true
	default:
	}
	return info
}

// ffmpegCommand builds the HLS transcode command used for downloads. `vod`
// finishes the playlist; downloads always want that, so the file is complete
// before it is saved.
func ffmpegCommand(ctx context.Context, ffmpeg, input, dir string, segmentSeconds int, vod bool) *exec.Cmd {
	playlistType := "event"
	if vod {
		playlistType = "vod"
	}
	return exec.CommandContext(ctx, ffmpeg,
		"-hide_banner", "-loglevel", "error",
		// Small probes start playback sooner; the remux below copies video.
		"-probesize", "2M", "-analyzeduration", "3M",
		"-i", input,
		"-map", "0:v:0", "-map", "0:a:0?",
		"-c:v", "copy",
		"-tag:v", "hvc1",
		"-c:a", "aac", "-b:a", "192k", "-ac", "2",
		"-f", "hls",
		"-hls_time", strconv.Itoa(segmentSeconds),
		"-hls_playlist_type", playlistType,
		"-hls_flags", "independent_segments+temp_file",
		"-hls_segment_filename", filepath.Join(dir, "seg%05d.ts"),
		filepath.Join(dir, "index.m3u8"),
	)
}

// torrentSpec parses a magnet and applies the candidate's trackers.
func torrentSpec(magnet string, trackers []string) (*torrent.TorrentSpec, error) {
	spec, err := torrent.TorrentSpecFromMagnetUri(magnet)
	if err != nil {
		return nil, fmt.Errorf("bad magnet: %w", err)
	}
	if len(trackers) > 0 {
		announce := make([][]string, 0, len(trackers))
		for _, tracker := range trackers {
			announce = append(announce, []string{tracker})
		}
		spec.Trackers = announce
	}
	return spec, nil
}

// prioritizeStart raises the first few megabytes of the episode to "now" so
// ffmpeg's opening read does not wait behind the rest of a large torrent.
func prioritizeStart(t *torrent.Torrent, file *torrent.File) {
	info := t.Info()
	if info == nil || info.PieceLength <= 0 {
		return
	}
	first := int(file.Offset() / info.PieceLength)
	last := int((file.Offset() + 8<<20) / info.PieceLength)
	total := t.NumPieces()
	for index := first; index <= last && index < total; index++ {
		if piece := t.Piece(index); piece != nil {
			piece.SetPriority(torrent.PiecePriorityNow)
		}
	}
}

// pickFile chooses the video file to stream from a torrent.
func pickFile(t *torrent.Torrent, fileIdx int) (*torrent.File, error) {
	files := t.Files()
	if len(files) == 0 {
		return nil, errors.New("torrent has no files")
	}
	if fileIdx >= 0 && fileIdx < len(files) {
		if isVideo(files[fileIdx].DisplayPath()) {
			return files[fileIdx], nil
		}
	}
	var best *torrent.File
	for _, file := range files {
		if !isVideo(file.DisplayPath()) {
			continue
		}
		if best == nil || file.Length() > best.Length() {
			best = file
		}
	}
	if best == nil {
		return nil, errors.New("torrent has no video file")
	}
	return best, nil
}

var videoExtensions = []string{".mkv", ".mp4", ".avi", ".webm", ".m4v", ".mov", ".ts"}

func isVideo(name string) bool {
	lower := strings.ToLower(name)
	for _, extension := range videoExtensions {
		if strings.HasSuffix(lower, extension) {
			return true
		}
	}
	return false
}

// buildMagnet assembles a magnet link for a candidate.
func buildMagnet(candidate Candidate) string {
	magnet := "magnet:?xt=urn:btih:" + candidate.InfoHash
	if candidate.Filename != "" {
		magnet += "&dn=" + url.QueryEscape(candidate.Filename)
	}
	for _, tracker := range candidate.Trackers {
		magnet += "&tr=" + url.QueryEscape(tracker)
	}
	return magnet
}

func fileSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func sanitize(value string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "?", "-", "*", "-", "\"", "-", "<", "-", ">", "-", "|", "-", " ", "_")
	cleaned := replacer.Replace(value)
	if len(cleaned) > 80 {
		cleaned = cleaned[:80]
	}
	if cleaned == "" {
		return "stream"
	}
	return cleaned
}

// tailWriter keeps the last `limit` bytes written to it.
type tailWriter struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.data = append(t.data, p...)
	if len(t.data) > t.limit {
		t.data = t.data[len(t.data)-t.limit:]
	}
	return len(p), nil
}

func (t *tailWriter) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.data)
}

func lastLines(value string, count int) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, " | ")
}


