package kuma

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// userAgent is used for both Torrentio and the ffmpeg metadata requests.
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// FFmpegStatus reports whether ffmpeg is usable and where it came from.
type FFmpegStatus struct {
	Available bool   `json:"available"`
	Path      string `json:"path"`
	Version   string `json:"version"`
	Managed   bool   `json:"managed"`
	Source    string `json:"source"`
}

// FFmpegPath resolves the configured or detected ffmpeg binary.
func FFmpegPath(settings Settings) FFmpegStatus {
	if settings.FFmpegPath != "" {
		if status := probeFFmpeg(settings.FFmpegPath, true); status.Available {
			return status
		}
	}
	managed := managedFFmpegPath()
	if _, err := os.Stat(managed); err == nil {
		if status := probeFFmpeg(managed, true); status.Available {
			return status
		}
	}
	if path, err := exec.LookPath("ffmpeg"); err == nil {
		if status := probeFFmpeg(path, false); status.Available {
			return status
		}
	}
	// Common Windows install locations, in case PATH is not set up.
	for _, candidate := range []string{
		`C:\ffmpeg\bin\ffmpeg.exe`,
		`C:\Program Files\ffmpeg\bin\ffmpeg.exe`,
		`/usr/local/bin/ffmpeg`,
		`/opt/homebrew/bin/ffmpeg`,
	} {
		if _, err := os.Stat(candidate); err == nil {
			if status := probeFFmpeg(candidate, false); status.Available {
				return status
			}
		}
	}
	return FFmpegStatus{Available: false}
}

func managedFFmpegPath() string {
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
	}
	return filepath.Join(configDir(), "bin", name)
}

// probeFFmpeg runs `ffmpeg -version` to confirm the binary works.
func probeFFmpeg(path string, managed bool) FFmpegStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "-version").Output()
	if err != nil {
		return FFmpegStatus{}
	}
	first := strings.SplitN(string(out), "\n", 2)[0]
	return FFmpegStatus{
		Available: true,
		Path:      path,
		Version:   strings.TrimSpace(first),
		Managed:   managed,
		Source:    map[bool]string{true: "downloaded", false: "system"}[managed],
	}
}

// FFmpegDownloadURL is the archive to fetch for this platform.
func FFmpegDownloadURL() (string, error) {
	switch runtime.GOOS {
	case "windows":
		return "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", nil
	case "linux":
		return "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz", nil
	case "darwin":
		return "", fmt.Errorf("automatic ffmpeg download is not available on macOS; install it with `brew install ffmpeg`")
	}
	return "", fmt.Errorf("unsupported platform %s", runtime.GOOS)
}

// torrentioResponse is the subset of Torrentio's stream payload we use.
type torrentioResponse struct {
	Streams []struct {
		Name     string `json:"name"`
		Title    string `json:"title"`
		InfoHash string `json:"infoHash"`
		FileIdx  *int   `json:"fileIdx"`
		Behavior struct {
			Filename string `json:"filename"`
		} `json:"behaviorHints"`
		Sources []string `json:"sources"`
	} `json:"streams"`
}

// Candidate is one torrent Torrentio offers for an episode.
type Candidate struct {
	InfoHash string   `json:"infoHash"`
	FileIdx  int      `json:"fileIdx"`
	Title    string   `json:"title"`
	Filename string   `json:"filename"`
	Quality  string   `json:"quality"`
	Seeders   int      `json:"seeders"`
	Size      string   `json:"size"`
	SizeBytes int64    `json:"sizeBytes"`
	Trackers  []string `json:"-"`
}

var seedPattern = regexp.MustCompile(`(?:👤|👥)\s*(\d+)`)
var qualityPattern = regexp.MustCompile(`(?i)\b(2160p|1440p|1080p|720p|480p|360p|4k)\b`)

// Lookup asks Torrentio for the episode's torrents, best-seeded first.
func Lookup(ctx context.Context, stremID string, kind string) ([]Candidate, error) {
	target := fmt.Sprintf("https://torrentio.strem.fun/stream/%s.json", strings.TrimPrefix(stremID, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", userAgent)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("torrentio: HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var payload torrentioResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}

	// The dub/sub split is only reliable when the release says so.
	wantDub := strings.EqualFold(kind, "dub")
	var out []Candidate
	for _, stream := range payload.Streams {
		if stream.InfoHash == "" {
			continue
		}
		text := stream.Title + " " + stream.Behavior.Filename
		lower := strings.ToLower(text)
		isDub := strings.Contains(lower, "dubbed") || strings.Contains(lower, "dub ") || strings.Contains(lower, "dual audio") || strings.Contains(lower, "multi audio")
		if wantDub && !isDub {
			continue
		}
		if !wantDub && strings.Contains(lower, "dubbed") && !strings.Contains(lower, "multi") && !strings.Contains(lower, "dual") {
			continue
		}
		candidate := Candidate{
			InfoHash: stream.InfoHash,
			Title:    firstLine(stream.Title),
			Filename: stream.Behavior.Filename,
		}
		if stream.FileIdx != nil {
			candidate.FileIdx = *stream.FileIdx
		}
		if match := seedPattern.FindStringSubmatch(stream.Title); len(match) == 2 {
			candidate.Seeders, _ = strconv.Atoi(match[1])
		}
		if match := qualityPattern.FindStringSubmatch(text); len(match) == 2 {
			candidate.Quality = strings.ToLower(match[1])
		}
		if match := regexp.MustCompile(`💾\s*([0-9.]+\s*[KMGT]B)`).FindStringSubmatch(stream.Title); len(match) == 2 {
			candidate.Size = match[1]
			candidate.SizeBytes = parseSize(match[1])
		}
		for _, source := range stream.Sources {
			if strings.HasPrefix(source, "tracker:") {
				candidate.Trackers = append(candidate.Trackers, strings.TrimPrefix(source, "tracker:"))
			}
		}
		out = append(out, candidate)
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Seeders != out[j].Seeders {
			return out[i].Seeders > out[j].Seeders
		}
		return qualityRank(out[i].Quality) > qualityRank(out[j].Quality)
	})
	if len(out) > 12 {
		out = out[:12]
	}
	return out, nil
}

// parseSize turns "1.49 GB" into bytes.
func parseSize(value string) int64 {
	match := regexp.MustCompile(`(?i)^([0-9.]+)\s*([KMGT]?)B$`).FindStringSubmatch(strings.TrimSpace(value))
	if len(match) != 3 {
		return 0
	}
	number, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0
	}
	multiplier := float64(1)
	switch strings.ToUpper(match[2]) {
	case "K":
		multiplier = 1024
	case "M":
		multiplier = 1024 * 1024
	case "G":
		multiplier = 1024 * 1024 * 1024
	case "T":
		multiplier = 1024 * 1024 * 1024 * 1024
	}
	return int64(number * multiplier)
}

func firstLine(value string) string {
	line := strings.SplitN(value, "\n", 2)[0]
	return strings.TrimSpace(line)
}

func qualityRank(quality string) int {
	switch quality {
	case "2160p", "4k":
		return 5
	case "1440p":
		return 4
	case "1080p":
		return 3
	case "720p":
		return 2
	case "480p":
		return 1
	}
	return 0
}

// stremIDFromMAL builds the Torrentio id for an anime episode. Torrentio keys
// anime on IMDb ("tt…") or Kitsu ("kitsu:<id>"); MAL ids are mapped through
// Kitsu's search, which is keyless.
func stremIDFromMAL(ctx context.Context, malID, episode int) (string, error) {
	kitsuID, err := kitsuIDForMAL(ctx, malID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("series/kitsu:%d:%d", kitsuID, episode), nil
}

// StremIDForTest exposes the id mapping for diagnostics.
func StremIDForTest(ctx context.Context, malID, episode int) (string, error) {
	return stremIDFromMAL(ctx, malID, episode)
}

// kitsuIDForMAL maps a MAL id onto Kitsu's anime id through Kitsu's own
// mappings endpoint (keyless, and reachable where Jikan is not).
func kitsuIDForMAL(ctx context.Context, malID int) (int, error) {
	query := url.Values{}
	query.Set("filter[externalSite]", "myanimelist/anime")
	query.Set("filter[externalId]", strconv.Itoa(malID))
	query.Set("include", "item")
	target := "https://kitsu.io/api/edge/mappings?" + query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("user-agent", userAgent)
	req.Header.Set("accept", "application/vnd.api+json")
	res, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return 0, fmt.Errorf("kitsu: HTTP %d", res.StatusCode)
	}

	var payload struct {
		Data []struct {
			Relationships struct {
				Item struct {
					Data struct {
						ID string `json:"id"`
					} `json:"data"`
				} `json:"item"`
			} `json:"relationships"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&payload); err != nil {
		return 0, err
	}
	if len(payload.Data) == 0 {
		return 0, fmt.Errorf("kitsu: no mapping for MAL %d", malID)
	}
	id, err := strconv.Atoi(payload.Data[0].Relationships.Item.Data.ID)
	if err != nil {
		return 0, fmt.Errorf("kitsu: bad id %q", payload.Data[0].Relationships.Item.Data.ID)
	}
	return id, nil
}
