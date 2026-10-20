package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"twisted/internal/cache"
	"twisted/internal/config"
	"twisted/internal/downloads"
	"twisted/internal/kuma"
	"twisted/internal/megaplay"
	"twisted/internal/providers"
	"twisted/internal/proxy"
	"twisted/internal/subtitles"
)

const Version = "0.1.0"

type AppInfo struct {
	Version     string `json:"version"`
	Platform    string `json:"platform"`
	ProxyURL    string `json:"proxyUrl"`
	CacheDir    string `json:"cacheDir"`
	DownloadsAt string `json:"downloadsDir"`
	Desktop     bool   `json:"desktop"`
}

type StreamTrack struct {
	URL      string `json:"url"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Default  bool   `json:"default"`
	// Source names the catalogue this track came from ("kitsu",
	// "opensubtitles"); empty means the stream's own embedded subtitles, which
	// always come first.
	Source string `json:"source,omitempty"`
}

// SubtitleSource is one extra catalogue the viewer can load for an episode.
type SubtitleSource struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type StreamRange struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type StreamInfo struct {
	URL        string        `json:"url"`
	Qualities  []string      `json:"qualities"`
	Subtitles  []StreamTrack `json:"subtitles"`
	Intro      *StreamRange  `json:"intro,omitempty"`
	Outro      *StreamRange  `json:"outro,omitempty"`
	ResolvedAt int64         `json:"resolvedAt"`
	Kind       string        `json:"kind"`
	// Provider is the mirror that served the stream ("ahiru", "inu", ...).
	Provider string `json:"provider"`
	// Server is the sub-server inside that mirror ("1", "2", ...).
	Server string `json:"server"`
	// Renditions maps every advertised label ("1080p") to its bits per second,
	// so the player can pick one that the measured link can sustain.
	Renditions map[string]int `json:"renditions,omitempty"`
	// SubtitleSources lists the extra catalogues the viewer can pull subtitles
	// from in the player's subtitle menu. The stream's own tracks are already
	// in Subtitles; these load on demand.
	SubtitleSources []SubtitleSource `json:"subtitleSources,omitempty"`
}

type Service struct {
	settings  config.Settings
	cache     *cache.Cache
	relay     *proxy.Relay
	downloads *downloads.Manager
	resolver  *megaplay.Resolver
	mu        sync.Mutex
	// Provider selection shared with the downloader.
	preferred []string
	servers   map[string]string
	relayBase string
	// Kuma (torrent) engine, created on first use after the viewer opts in.
	kuma      *kuma.Engine
	kumaError string
	// Bandwidth estimate used to pick a rendition the link can sustain.
	speed *SpeedTest
}

// KumaSettings is the local-only torrent configuration.
type KumaSettings = kuma.Settings

// KumaStatus describes what the torrent engine needs to work here.
type KumaStatus struct {
	Enabled  bool          `json:"enabled"`
	FFmpeg   kuma.FFmpegStatus `json:"ffmpeg"`
	CacheDir string        `json:"cacheDir"`
	Error    string        `json:"error,omitempty"`
}

// GetKumaSettings returns the local torrent settings.
func (s *Service) GetKumaSettings() KumaSettings {
	return kuma.Load()
}

// SaveKumaSettings persists the local torrent settings (never synced).
func (s *Service) SaveKumaSettings(next KumaSettings) (KumaSettings, error) {
	next = kuma.Normalize(next)
	if err := kuma.Save(next); err != nil {
		return next, err
	}
	s.mu.Lock()
	if s.kuma != nil {
		s.kuma.Close()
		s.kuma = nil
	}
	s.mu.Unlock()
	return next, nil
}

// KumaStatus reports whether torrent playback can run on this machine.
func (s *Service) KumaStatus() KumaStatus {
	settings := kuma.Load()
	status := KumaStatus{
		Enabled:  settings.Enabled,
		FFmpeg:   kuma.FFmpegPath(settings),
		CacheDir: settings.CacheDir,
	}
	s.mu.Lock()
	status.Error = s.kumaError
	s.mu.Unlock()
	return status
}

// DownloadFFmpeg fetches a static ffmpeg build for this platform.
func (s *Service) DownloadFFmpeg() (kuma.FFmpegStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	status, err := kuma.DownloadFFmpeg(ctx, nil)
	if err != nil {
		return status, err
	}
	settings := kuma.Load()
	settings.FFmpegPath = status.Path
	if err := kuma.Save(settings); err != nil {
		return status, err
	}
	return status, nil
}

// kumaEngine lazily starts the torrent engine once it is enabled.
func (s *Service) kumaEngine() (*kuma.Engine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.kuma != nil {
		return s.kuma, nil
	}
	settings := kuma.Load()
	if !settings.Enabled {
		return nil, kuma.ErrDisabled
	}
	engine, err := kuma.NewEngine(settings)
	if err != nil {
		s.kumaError = err.Error()
		return nil, err
	}
	s.kuma = engine
	s.kumaError = ""
	if s.relay != nil {
		s.relay.SetKumaHandler(engine.Handler())
	}
	return engine, nil
}

// ResolveKuma starts torrent playback for an episode and returns a local HLS
// URL the built-in player streams like any other source. `infoHash` picks a
// specific release (the "choose in player" flow); empty means "best match".
func (s *Service) ResolveKuma(malID, episode int, kind string, infoHash string) (*StreamInfo, error) {
	engine, err := s.kumaEngine()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	settings := kuma.Load()
	var info *kuma.StreamInfo
	if infoHash != "" {
		info, err = engine.StartChosen(ctx, malID, episode, kind, infoHash, settings.SegmentSeconds)
	} else {
		info, err = engine.ResolveAndStart(ctx, malID, episode, kind, settings.SegmentSeconds)
	}
	if err != nil {
		return nil, err
	}
	// HLS is served by the relay so the webview uses one origin.
	rel := strings.TrimPrefix(filepath.ToSlash(info.Playlist), filepath.ToSlash(settings.CacheDir)+"/hls/")

	// Torrents carry no subtitle stream the webview can use, so the episode's
	// subtitles come from the Stremio subtitle addon. They are proxied through
	// the relay: the webview refuses cross-origin <track> files.
	tracks := []StreamTrack{}
	if subtitles, err := kuma.Subtitles(ctx, malID, episode); err == nil {
		for _, track := range subtitles {
			tracks = append(tracks, StreamTrack{
				URL:      s.relay.Wrap(track.URL),
				Label:    track.Label,
				Language: track.Language,
				Default:  track.Default,
			})
		}
	}

	return &StreamInfo{
		URL:        s.relayURL("/kuma/" + rel),
		Qualities:  []string{"auto"},
		Subtitles:  tracks,
		Provider:   "kuma",
		Server:     "torrent",
		ResolvedAt: time.Now().UnixMilli(),
		Kind:       megaplay.NormalizeKind(kind),
	}, nil
}

// KumaCandidates lists the torrents that fit the configured quality/size rules.
// `minutes` is the episode length (0 = the 24 minute default) so the size
// budget scales with longer episodes.
func (s *Service) KumaCandidates(malID, episode int, kind string, minutes float64) ([]kuma.Candidate, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	engine, err := s.kumaEngine()
	if err != nil {
		return nil, err
	}
	return engine.CandidatesFor(ctx, malID, episode, kind, minutes)
}

// ResolveKumaStream resolves a specific release chosen in the player.
func (s *Service) ResolveKumaStream(malID, episode int, kind, infoHash string) (*StreamInfo, error) {
	return s.ResolveKuma(malID, episode, kind, infoHash)
}

func New(settings config.Settings, disk *cache.Cache, relay *proxy.Relay, manager *downloads.Manager) *Service {
	service := &Service{
		settings:  settings,
		cache:     disk,
		relay:     relay,
		downloads: manager,
		resolver:  megaplay.New(),
		preferred: []string{"neko", "ahiru", "inu", "tora"},
		servers:   map[string]string{},
		speed:     newSpeedTest(),
	}
	if manager != nil {
		manager.SetProviderChoice(service.preferred, service.serverFor)
	}
	return service
}

// SetRelayBase tells the service the public prefix the relay is mounted on,
// so URLs handed to the frontend stay same-origin.
func (s *Service) SetRelayBase(prefix string) {
	s.mu.Lock()
	s.relayBase = strings.TrimSuffix(prefix, "/")
	s.mu.Unlock()
}

// relayURL builds a same-origin URL for the local relay.
func (s *Service) relayURL(path string) string {
	s.mu.Lock()
	base := s.relayBase
	s.mu.Unlock()
	if base == "" {
		return s.relay.BaseURL() + path
	}
	return base + path
}

// ProviderInfo describes one mirror for the UI.
type ProviderInfo struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Servers []string `json:"servers"`
}

// Providers lists the mirrors the app can resolve episodes from.
func (s *Service) Providers() []ProviderInfo {
	out := make([]ProviderInfo, 0, len(providers.List())+1)
	for _, provider := range providers.List() {
		entry := ProviderInfo{ID: provider.ID(), Name: provider.Name()}
		for _, server := range provider.Servers() {
			entry.Servers = append(entry.Servers, server.ID)
		}
		out = append(out, entry)
	}
	// Kuma is offered last: it is opt-in and depends on ffmpeg.
	out = append(out, ProviderInfo{ID: "kuma", Name: "Kuma", Servers: []string{}})
	return out
}

// SelectProvider sets which mirror is tried first (and used for downloads).
func (s *Service) SelectProvider(id string) {
	s.mu.Lock()
	if providers.Find(id) != nil {
		s.preferred = []string{id}
	}
	preferred := append([]string(nil), s.preferred...)
	s.mu.Unlock()
	if s.downloads != nil {
		s.downloads.SetProviderChoice(preferred, s.serverFor)
	}
}

// SelectServer picks the sub-server used for one provider (e.g. inu-2).
func (s *Service) SelectServer(providerID, server string) {
	s.mu.Lock()
	if s.servers == nil {
		s.servers = map[string]string{}
	}
	s.servers[providerID] = server
	preferred := append([]string(nil), s.preferred...)
	s.mu.Unlock()
	if s.downloads != nil {
		s.downloads.SetProviderChoice(preferred, s.serverFor)
	}
}

// serverFor reads the current sub-server choice for a provider.
func (s *Service) serverFor(providerID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.servers[providerID]
}

func (s *Service) ServiceName() string {
	return "Desktop"
}

func (s *Service) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	return nil
}

func (s *Service) ServiceShutdown() error {
	return nil
}

func (s *Service) AppInfo() AppInfo {
	return AppInfo{
		Version:     Version,
		Platform:    runtime.GOOS,
		ProxyURL:    s.relay.BaseURL(),
		CacheDir:    s.settings.CacheDir(),
		DownloadsAt: s.settings.DownloadsDir,
		Desktop:     true,
	}
}

func (s *Service) GetSettings() config.Settings {
	return s.settings
}

func (s *Service) SaveSettings(next config.Settings) (config.Settings, error) {
	next = config.Normalize(next)
	if err := config.Save(next); err != nil {
		return next, err
	}
	previous := s.settings
	s.settings = next

	s.cache.SetEnabled(next.CacheEnabled)
	s.cache.SetMaxMB(next.CacheMaxMB)
	s.relay.SetEnabled(next.CacheEnabled)
	if s.downloads != nil {
		s.downloads.SetConcurrency(next.MaxConcurrentDownloads)
		if previous.DownloadsDir != next.DownloadsDir {
			s.downloads.SetRoot(next.DownloadsDir)
		}
	}
	return next, nil
}

func (s *Service) CacheStats() cache.Stats {
	return s.cache.Stats()
}

func (s *Service) ClearCache() int64 {
	return s.cache.Clear()
}

// ClearEpisodeCache drops the cached media for one episode's stream and, for
// Kuma, stops the running torrent session so the next play starts from scratch.
// This backs the "clear cache" button next to the player toggles.
func (s *Service) ClearEpisodeCache(providerID string, malID, episode int, kind string) (int64, error) {
	var freed int64
	if providerID != "" && providerID != "kuma" {
		if found := providers.Find(providerID); found != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
			defer cancel()
			source, err := found.Resolve(ctx, malID, episode, providers.Kind(megaplay.NormalizeKind(kind)), s.serverFor(providerID))
			if err == nil && source != nil {
				freed += s.cache.PurgeURL(source.URL)
			}
		}
	}
	if providerID == "kuma" {
		s.mu.Lock()
		engine := s.kuma
		s.mu.Unlock()
		if engine != nil {
			engine.Stop(fmt.Sprintf("%d-%d-%s", malID, episode, megaplay.NormalizeKind(kind)))
		}
	}
	return freed, nil
}

func (s *Service) OpenDownloadsFolder() error {
	if err := os.MkdirAll(s.settings.DownloadsDir, 0o755); err != nil {
		return err
	}
	return openPath(s.settings.DownloadsDir)
}

func (s *Service) OpenCacheFolder() error {
	return openPath(s.settings.CacheDir())
}

// PlayerInfo is one video player found on the machine.
type PlayerInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Streams bool   `json:"streams"`
	Kind    string `json:"kind"`
}

// candidatePlayers lists the players we know how to launch, in the order they
// are probed. "system" means "whatever the OS opens .m3u8 with".
var candidatePlayers = []PlayerInfo{
	{ID: "vlc", Name: "VLC", Streams: true, Kind: "vlc"},
	{ID: "mpv", Name: "mpv", Streams: true, Kind: "mpv"},
	{ID: "mpc", Name: "MPC-HC", Streams: true, Kind: "generic"},
	{ID: "potplayer", Name: "PotPlayer", Streams: true, Kind: "generic"},
	{ID: "mpcbe", Name: "MPC-BE", Streams: true, Kind: "generic"},
}

// knownPlayerPaths are the usual install locations, per executable.
var knownPlayerPaths = map[string][]string{
	"vlc": {
		`C:\Program Files\VideoLAN\VLC\vlc.exe`,
		`C:\Program Files (x86)\VideoLAN\VLC\vlc.exe`,
		`/Applications/VLC.app/Contents/MacOS/VLC`,
	},
	"mpv": {
		`C:\Program Files\mpv\mpv.exe`,
		`C:\Program Files\mpv.net\mpv.net.exe`,
		`/Applications/mpv.app/Contents/MacOS/mpv`,
		`/usr/bin/mpv`,
	},
	"mpc": {
		`C:\Program Files\MPC-HC\mpc-hc64.exe`,
		`C:\Program Files (x86)\MPC-HC\mpc-hc.exe`,
	},
	"mpcbe": {
		`C:\Program Files\MPC-BE x64\mpc-be64.exe`,
		`C:\Program Files\MPC-BE\mpc-be.exe`,
	},
	"potplayer": {
		`C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe`,
		`C:\Program Files (x86)\DAUM\PotPlayer\PotPlayerMini.exe`,
	},
}

// playerExecutables maps a player id to the executable names that identify it.
// Probing must stay per-id: the registry fallback used to walk every known
// executable, so each player "resolved" to whichever one happened to be
// installed (VLC), and the settings list showed VLC under every name.
var playerExecutables = map[string][]string{
	"vlc":       {"vlc.exe", "vlc"},
	"mpv":       {"mpv.exe", "mpv", "mpvnet.exe"},
	"mpc":       {"mpc-hc64.exe", "mpc-hc.exe", "mpc-hc64_nvo.exe"},
	"mpcbe":     {"mpc-be64.exe", "mpc-be.exe"},
	"potplayer": {"PotPlayerMini64.exe", "PotPlayerMini.exe", "PotPlayer64.exe"},
}

// findPlayer resolves the configured id to an executable that exists.
func findPlayer(id string) (string, error) {
	if id == "system" {
		return "", nil
	}
	if path, err := exec.LookPath(id); err == nil {
		return path, nil
	}
	for _, path := range knownPlayerPaths[id] {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	// Registry App Paths (Windows installs outside Program Files). Only this
	// player's own executables are probed, never another player's.
	for _, exe := range playerExecutables[id] {
		if path := appPath(exe); path != "" {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s is not installed", id)
}

var (
	playersMu    sync.Mutex
	playersCache []PlayerInfo
	playersAt    time.Time
)

// ListPlayers reports the video players actually available on this machine.
// The scan touches the disk and the registry, so its result is cached: opening
// settings must not re-probe every player each time.
func (s *Service) ListPlayers() []PlayerInfo {
	playersMu.Lock()
	defer playersMu.Unlock()
	if !playersAt.IsZero() && time.Since(playersAt) < 5*time.Minute {
		return playersCache
	}

	found := []PlayerInfo{}
	for _, candidate := range candidatePlayers {
		path, err := findPlayer(candidate.ID)
		if err != nil || path == "" {
			continue
		}
		candidate.Path = path
		found = append(found, candidate)
	}
	playersCache = found
	playersAt = time.Now()
	return found
}

// launch hands a target to the configured player. "system" asks the OS to open
// it (which uses the user's default app for that file/url type).
func launch(id, target string) error {
	path, err := findPlayer(id)
	if err != nil {
		return err
	}
	if path == "" {
		return openPath(target)
	}
	command := exec.Command(path, target)
	if err := command.Start(); err != nil {
		return fmt.Errorf("could not launch %s: %w", path, err)
	}
	return nil
}

// PlayExternal opens a stream URL in the configured external player.
func (s *Service) PlayExternal(target string) error {
	if !strings.HasPrefix(target, "https://") && !strings.HasPrefix(target, "http://") {
		return errors.New("unsupported url")
	}
	// The frontend only asks for this when an external player is chosen; if the
	// stored preference is still "builtin" (e.g. changed before settings synced)
	// fall back to the OS handler rather than refusing.
	if s.settings.Player == "builtin" {
		return openPath(target)
	}
	return launch(s.settings.Player, target)
}

// OpenFile opens a file on disk with the configured player, or the OS handler.
func (s *Service) OpenFile(target string) error {
	if target == "" {
		return errors.New("missing path")
	}
	return launch(s.settings.Player, target)
}

// Quit terminates the whole application, not just the window: the window close
// path can leave the process alive when a handler intercepts it, so the custom
// title-bar button asks for a real shutdown.
func (s *Service) Quit() {
	if app := application.Get(); app != nil {
		app.Quit()
	}
}

// DownloadsPath returns where one downloaded episode lives on disk.
func (s *Service) DownloadsPath(id string) (string, error) {
	if s.downloads == nil {
		return "", errors.New("downloads unavailable")
	}
	return s.downloads.Dir(id)
}

// LocalPlaylistPath returns the saved playlist for a download, which is what an
// external player should open (it references the local segment files).
func (s *Service) LocalPlaylistPath(id string) (string, error) {
	if s.downloads == nil {
		return "", errors.New("downloads unavailable")
	}
	dir, err := s.downloads.Dir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "playlist.m3u8"), nil
}
func openPath(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// explorer.exe is the documented way to hand a file or folder to its
		// default handler; `explorer <file>` without the flag can land in
		// Documents instead.
		command = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", filepath.FromSlash(target))
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	return command.Start()
}

func (s *Service) OpenExternal(target string) error {
	if !strings.HasPrefix(target, "https://") && !strings.HasPrefix(target, "http://") {
		return errors.New("unsupported url")
	}
	return openPath(target)
}

func (s *Service) ResolveStream(malID, episode int, kind string, providerID string) (*StreamInfo, error) {
	// The chain gives each provider its own budget (see providers.ProviderBudget),
	// so this only needs to cover three of them plus the playlist probe. A dead
	// mirror that stalls can no longer consume the whole deadline and make a
	// working episode look missing.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	s.mu.Lock()
	preferred := append([]string(nil), s.preferred...)
	s.mu.Unlock()
	if providerID == "kuma" {
		return s.ResolveKuma(malID, episode, kind, "")
	}
	if providerID != "" && providers.Find(providerID) != nil {
		preferred = []string{providerID}
	}

	source, err := providers.Resolve(ctx, preferred, malID, episode, providers.Kind(megaplay.NormalizeKind(kind)), s.serverFor)
	if err != nil {
		// A timeout is transient: one retry with the chain reordered to the
		// providers that were not tried first is worth it, and it is far better
		// than telling the viewer the episode does not exist.
		if !providers.IsNotFound(err) {
			retry, retryCancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer retryCancel()
			if next, retryErr := providers.Resolve(retry, rotatePreferred(preferred), malID, episode, providers.Kind(megaplay.NormalizeKind(kind)), s.serverFor); retryErr == nil {
				source = next
				err = nil
			}
		}
	}
	if err != nil {
		return nil, err
	}

	// Rendition labels come from the master playlist, fetched with the
	// provider's own headers (both mirrors reject requests without them).
	qualities := []string{"auto"}
	renditions := map[string]int{}
	if variants, err := s.masterVariants(ctx, source); err == nil {
		for _, variant := range variants {
			qualities = append(qualities, variant.Label)
			if variant.Label != "" && variant.Bandwidth > 0 {
				renditions[variant.Label] = variant.Bandwidth
			}
		}
	}

	tracks := make([]StreamTrack, 0, len(source.Tracks))
	for _, track := range source.Tracks {
		// Subtitle files need the right Referer, which can differ from the
		// video host (ahiru's subtitles live on hls.dramahot.top).
		referer, origin := source.Referer, source.Origin
		if track.Referer != "" {
			referer, origin = track.Referer, track.Origin
		}
		tracks = append(tracks, StreamTrack{
			URL:      s.relay.WrapWith(track.URL, referer, origin),
			Label:    track.Label,
			Language: track.Language,
			Default:  track.Default,
		})
	}

	info := &StreamInfo{
		// Master playlists must go through the relay with rewrite=1: the
		// player then sees child URLs already proxied, so no request escapes
		// to the mirror from a foreign origin (which the webview blocks).
		URL:        s.relay.WrapWith(source.URL, source.Referer, source.Origin),
		Qualities:  qualities,
		Subtitles:  tracks,
		ResolvedAt: source.Fetched.UnixMilli(),
		Kind:       megaplay.NormalizeKind(kind),
		Provider:   source.Provider,
		Server:     source.Server,
		Renditions: renditions,
		// Which extra catalogues exist is cheap to answer and lets the subtitle
		// menu show "OpenSubtitles (57)" without a second round-trip.
		SubtitleSources: s.subtitleSources(ctx, malID, episode),
	}
	if source.Intro != nil {
		info.Intro = &StreamRange{Start: source.Intro.Start, End: source.Intro.End}
	}
	if source.Outro != nil {
		info.Outro = &StreamRange{Start: source.Outro.Start, End: source.Outro.End}
	}
	return info, nil
}

// rotatePreferred puts the second provider first, so a retry after a timeout
// does not wait on the same stalled mirror again.
func rotatePreferred(preferred []string) []string {
	if len(preferred) < 2 {
		return preferred
	}
	rotated := append([]string(nil), preferred[1:]...)
	return append(rotated, preferred[0])
}

// subtitleSources lists the extra subtitle catalogues for an episode.
func (s *Service) subtitleSources(ctx context.Context, malID, episode int) []SubtitleSource {
	list := subtitles.Catalogues(ctx, malID, episode)
	out := make([]SubtitleSource, 0, len(list))
	for _, source := range list {
		out = append(out, SubtitleSource{ID: source.ID, Name: source.Name, Count: source.Count})
	}
	return out
}

// LoadSubtitles fetches one extra subtitle catalogue for an episode. The
// player calls this when the viewer picks a source in the subtitle menu; the
// URLs are proxied through the relay like the stream's own tracks, and the
// relay converts the SRT the addons serve into WebVTT.
func (s *Service) LoadSubtitles(source string, malID, episode int) ([]StreamTrack, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tracks, err := subtitles.Fetch(ctx, source, malID, episode)
	if err != nil {
		return nil, err
	}
	out := make([]StreamTrack, 0, len(tracks))
	for _, track := range tracks {
		out = append(out, StreamTrack{
			// No referer: these CDNs serve subtitle files openly.
			URL:      s.relay.Wrap(track.URL),
			Label:    track.Label,
			Language: track.Language,
			Default:  false,
			Source:   track.Source,
		})
	}
	return out, nil
}

// masterVariants reads the master playlist through the provider's headers.
func (s *Service) masterVariants(ctx context.Context, source *providers.Stream) ([]megaplay.Variant, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	if source.Referer != "" {
		req.Header.Set("referer", source.Referer)
	}
	if source.Origin != "" {
		req.Header.Set("origin", source.Origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("playlist HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	return megaplay.ParseMaster(string(data), source.URL), nil
}
// MeasureSpeed runs one bandwidth probe and returns the running estimate. The
// player calls it while something is playing; it is cheap enough to repeat and
// a call made while a probe is in flight just returns the current estimate.
func (s *Service) MeasureSpeed() (SpeedResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return s.speed.Measure(ctx)
}

// SpeedEstimate is the last measurement without starting a new probe.
func (s *Service) SpeedEstimate() SpeedResult {
	return s.speed.Result()
}

// RecommendedQuality picks the tallest rendition the measured link can sustain,
// or "" when nothing has been measured yet.
func (s *Service) RecommendedQuality(renditions map[string]int) string {
	return s.speed.RecommendedHeight(renditions)
}

func (s *Service) ListDownloads() []downloads.Item {
	if s.downloads == nil {
		return nil
	}
	return s.downloads.List()
}

func (s *Service) AddDownload(request downloads.Item) (downloads.Item, error) {
	if s.downloads == nil {
		return downloads.Item{}, errors.New("downloads unavailable")
	}
	return s.downloads.Add(request)
}

func (s *Service) PauseDownload(id string) (downloads.Item, error) {
	if s.downloads == nil {
		return downloads.Item{}, errors.New("downloads unavailable")
	}
	return s.downloads.Pause(id)
}

func (s *Service) ResumeDownload(id string) (downloads.Item, error) {
	if s.downloads == nil {
		return downloads.Item{}, errors.New("downloads unavailable")
	}
	return s.downloads.Resume(id)
}

func (s *Service) RetryDownload(id string) (downloads.Item, error) {
	if s.downloads == nil {
		return downloads.Item{}, errors.New("downloads unavailable")
	}
	return s.downloads.Retry(id)
}

func (s *Service) RemoveDownload(id string) error {
	if s.downloads == nil {
		return errors.New("downloads unavailable")
	}
	return s.downloads.Remove(id)
}

func (s *Service) PlayDownload(id string) string {
	if s.downloads == nil {
		return ""
	}
	return s.downloads.PlayURL(id)
}

func (s *Service) DownloadMetadata(id string) (map[string]any, error) {
	if s.downloads == nil {
		return nil, errors.New("downloads unavailable")
	}
	return s.downloads.Metadata(id)
}
