package kuma

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Session is one active torrent playback, addressed by its local HLS path.
type Session struct {
	Stream *Stream
	Title  string
}

// ResolveAndStart looks the episode up on Torrentio and starts the first
// candidate that produces a playable playlist. Best-seeded releases are tried
// first, so a dead swarm does not stop the others.
func (e *Engine) ResolveAndStart(ctx context.Context, malID, episode int, kind string, segmentSeconds int) (*StreamInfo, error) {
	candidates, err := e.Candidates(ctx, malID, episode, kind)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, errors.New("no torrents found for this episode")
	}
	if len(candidates) > 4 {
		candidates = candidates[:4]
	}

	var lastErr error
	for _, candidate := range candidates {
		id := fmt.Sprintf("%d-%d-%s-%s", malID, episode, kind, candidate.InfoHash[:8])
		// A short per-candidate budget keeps a dead swarm from stalling the UI.
		attemptCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		info, err := e.Start(attemptCtx, id, candidate, kind, segmentSeconds)
		cancel()
		if err == nil {
			info.Title = candidate.Filename
			return info, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no playable torrent")
	}
	return nil, lastErr
}

// ErrNeedsChoice means the viewer picked "choose in player" and has not chosen
// a release yet; the UI shows the candidate list instead of a stream.
var ErrNeedsChoice = errors.New("choose a torrent")

// StartChosen starts a specific release the viewer picked in the player.
func (e *Engine) StartChosen(ctx context.Context, malID, episode int, kind, infoHash string, segmentSeconds int) (*StreamInfo, error) {
	candidates, err := e.Candidates(ctx, malID, episode, kind)
	if err != nil {
		return nil, err
	}
	for _, candidate := range candidates {
		if !strings.EqualFold(candidate.InfoHash, infoHash) {
			continue
		}
		id := fmt.Sprintf("%d-%d-%s-%s", malID, episode, kind, candidate.InfoHash[:8])
		info, err := e.Start(ctx, id, candidate, kind, segmentSeconds)
		if err != nil {
			return nil, err
		}
		info.Title = candidate.Filename
		return info, nil
	}
	return nil, errors.New("torrent not found for this episode")
}

// EpisodeMinutes is the assumed length when picking by size.
const EpisodeMinutes = 24

// Candidates returns the releases that satisfy the configured quality and size
// budget, best first. When nothing fits, `IfNothingFits` decides: "closest"
// returns the smallest releases anyway, "ask" returns ErrNeedsChoice so the
// player can show the list.
func (e *Engine) Candidates(ctx context.Context, malID, episode int, kind string) ([]Candidate, error) {
	stremID, err := stremIDFromMAL(ctx, malID, episode)
	if err != nil {
		return nil, err
	}
	all, err := Lookup(ctx, stremID, kind)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, nil
	}
	return filterCandidates(all, e.settings), nil
}

// CandidatesFor is Candidates with an explicit episode length in minutes.
func (e *Engine) CandidatesFor(ctx context.Context, malID, episode int, kind string, minutes float64) ([]Candidate, error) {
	stremID, err := stremIDFromMAL(ctx, malID, episode)
	if err != nil {
		return nil, err
	}
	all, err := Lookup(ctx, stremID, kind)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, nil
	}
	return filterCandidatesFor(all, e.settings, minutes), nil
}

// filterCandidates applies the quality and size rules from settings.
func filterCandidates(all []Candidate, settings Settings) []Candidate {
	return filterCandidatesFor(all, settings, EpisodeMinutes)
}

// filterCandidatesFor applies the rules with a length-scaled budget: the
// configured max is for a 24 minute episode, longer ones get proportionally
// more room.
func filterCandidatesFor(all []Candidate, settings Settings, minutes float64) []Candidate {
	budgetMB := ScaledBudgetMB(settings.MaxEpisodeMB, minutes)
	budget := budgetMB * 1024 * 1024
	if budget <= 0 {
		budget = 1200 * 1024 * 1024
	}

	wanted := strings.ToLower(settings.Quality)
	matching := make([]Candidate, 0, len(all))
	for _, candidate := range all {
		if wanted != "" && wanted != "best" && candidate.Quality != wanted {
			continue
		}
		// Releases without a parsed size are kept: they may still fit.
		if candidate.SizeBytes > 0 && candidate.SizeBytes > budget {
			continue
		}
		matching = append(matching, candidate)
	}
	if len(matching) > 0 {
		return matching
	}

	// Nothing fits the budget. "closest" keeps the smallest releases (they
	// are the least likely to blow through the data plan); "ask" leaves the
	// decision to the viewer in the player.
	sorted := append([]Candidate(nil), all...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].SizeBytes == 0 {
			return false
		}
		if sorted[j].SizeBytes == 0 {
			return true
		}
		return sorted[i].SizeBytes < sorted[j].SizeBytes
	})
	if settings.IfNothingFits == "ask" {
		return sorted
	}
	if len(sorted) > 4 {
		sorted = sorted[:4]
	}
	return sorted
}

// ScaledBudgetMB is the size budget for an episode of the given length, with
// the 24 minute value scaled proportionally.
func ScaledBudgetMB(maxEpisodeMB int64, minutes float64) int64 {
	if minutes <= 0 {
		minutes = EpisodeMinutes
	}
	return int64(float64(maxEpisodeMB) * (minutes / EpisodeMinutes))
}

// Handler serves the generated HLS files for the player. It is mounted on the
// local relay under /kuma/, so the webview talks to one origin (CORS included).
//
// The playlist lists every segment of the episode from the start (so the player
// knows the real duration), which means it asks for segments ffmpeg may not have
// written yet. Those requests wait for the file instead of 404ing: playback then
// stalls at the download edge like it would on a slow connection, rather than
// failing outright.
func (e *Engine) Handler() http.Handler {
	root := filepath.Join(e.settings.CacheDir, "hls")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("access-control-allow-origin", "*")
		relative := strings.TrimPrefix(r.URL.Path, "/kuma/")
		cleaned := filepath.Clean("/" + relative)
		target, err := filepath.Abs(filepath.Join(root, cleaned))
		if err != nil || !strings.HasPrefix(target, root) {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(target, ".m3u8") {
			w.Header().Set("content-type", "application/vnd.apple.mpegurl")
			w.Header().Set("cache-control", "no-store")
			http.ServeFile(w, r, target)
			return
		}
		if strings.HasSuffix(target, ".ts") {
			if !waitForFile(r.Context(), target, 3*time.Minute) {
				http.Error(w, "segment not available", http.StatusGatewayTimeout)
				return
			}
			w.Header().Set("content-type", "video/mp2t")
			w.Header().Set("cache-control", "no-store")
			http.ServeFile(w, r, target)
			return
		}
		http.ServeFile(w, r, target)
	})
}

// waitForFile blocks until the file exists (or the request is cancelled). HLS
// segment writes are atomic (`temp_file`), so an existing file is complete.
func waitForFile(ctx context.Context, path string, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// DownloadTo runs the same torrent→HLS pipeline into a download directory, so a
// saved Kuma episode plays offline like any other provider.
func (e *Engine) DownloadTo(ctx context.Context, malID, episode int, kind, dir string) error {
	stremID, err := stremIDFromMAL(ctx, malID, episode)
	if err != nil {
		return err
	}
	candidates, err := Lookup(ctx, stremID, kind)
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		return errors.New("no torrents found for this episode")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	var lastErr error
	for index, candidate := range candidates {
		if index >= 3 {
			break
		}
		if err := e.downloadCandidate(ctx, candidate, dir); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("no playable torrent")
	}
	return lastErr
}

// downloadCandidate streams one candidate to completion in the target dir.
func (e *Engine) downloadCandidate(ctx context.Context, candidate Candidate, dir string) error {
	e.mu.Lock()
	client := e.client
	e.mu.Unlock()
	if client == nil {
		return errors.New("torrent engine is closed")
	}

	magnet := buildMagnet(candidate)
	spec, err := torrentSpec(magnet, candidate.Trackers)
	if err != nil {
		return err
	}
	t, _, err := client.AddTorrentSpec(spec)
	if err != nil {
		return err
	}
	defer t.Drop()

	select {
	case <-t.GotInfo():
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(90 * time.Second):
		return errors.New("timed out waiting for torrent metadata")
	}

	file, err := pickFile(t, candidate.FileIdx)
	if err != nil {
		return err
	}
	file.Download()

	// ffmpeg runs to completion: the resulting playlist is a finished VOD.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream := &Stream{engine: e, id: filepath.Base(dir), torrent: t, file: file, dir: dir}
	readerURL, err := e.serveFile(runCtx, stream)
	if err != nil {
		return err
	}

	cmd := ffmpegCommand(runCtx, e.ffmpeg.Path, readerURL, dir, e.settings.SegmentSeconds, true)
	logTail := &tailWriter{limit: 4096}
	cmd.Stderr = logTail
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := cmd.Wait(); err != nil {
		if tail := strings.TrimSpace(logTail.String()); tail != "" {
			return fmt.Errorf("%w: %s", err, lastLines(tail, 3))
		}
		return err
	}

	// The downloader expects playlist.m3u8.
	generated := filepath.Join(dir, "index.m3u8")
	if _, err := os.Stat(generated); err != nil {
		return errors.New("ffmpeg produced no playlist")
	}
	return os.Rename(generated, filepath.Join(dir, "playlist.m3u8"))
}


