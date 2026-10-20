package kuma

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Settings are Kuma's local-only preferences: torrent streaming is opt-in and
// never leaves this device (it is deliberately excluded from the profile and
// vault copies).
type Settings struct {
	Enabled        bool   `json:"enabled"`
	FFmpegPath     string `json:"ffmpegPath"`
	CacheDir       string `json:"cacheDir"`
	CacheLimitMB   int64  `json:"cacheLimitMB"`
	SegmentSeconds int    `json:"segmentSeconds"`
	ListenPort     int    `json:"listenPort"`
	// MaxEpisodeMB is the size budget for a ~24 minute episode; longer
	// episodes scale it up proportionally.
	MaxEpisodeMB int64 `json:"maxEpisodeMB"`
	// IfNothingFits decides what happens when every release exceeds the budget.
	IfNothingFits string `json:"ifNothingFits"`
	// Quality is "best" or a concrete label such as "1080p".
	Quality string `json:"quality"`
	// PickMode: "auto" streams the best match, "choose" lists every stream in
	// the player and waits for the viewer to pick one.
	PickMode string `json:"pickMode"`
}

func Default() Settings {
	return Settings{
		Enabled:        false,
		CacheDir:       filepath.Join(configDir(), "kuma"),
		CacheLimitMB:   20480,
		SegmentSeconds: 6,
		ListenPort:     0,
		MaxEpisodeMB:   1200,
		IfNothingFits:  "closest",
		Quality:        "best",
		PickMode:       "auto",
	}
}

func configDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "Twist")
	}
	return filepath.Join(dir, "Twist")
}

func settingsPath() string {
	return filepath.Join(configDir(), "kuma.json")
}

// Load reads the local Kuma settings, filling in defaults.
func Load() Settings {
	settings := Default()
	data, err := os.ReadFile(settingsPath())
	if err != nil {
		return settings
	}
	if json.Unmarshal(data, &settings) != nil {
		return Default()
	}
	return Normalize(settings)
}

func Normalize(settings Settings) Settings {
	defaults := Default()
	if settings.CacheDir == "" {
		settings.CacheDir = defaults.CacheDir
	}
	if settings.CacheLimitMB < 512 {
		settings.CacheLimitMB = defaults.CacheLimitMB
	}
	if settings.SegmentSeconds < 2 || settings.SegmentSeconds > 20 {
		settings.SegmentSeconds = defaults.SegmentSeconds
	}
	if settings.ListenPort < 0 || settings.ListenPort > 65535 {
		settings.ListenPort = 0
	}
	if settings.MaxEpisodeMB < 100 {
		settings.MaxEpisodeMB = defaults.MaxEpisodeMB
	}
	if settings.IfNothingFits != "closest" && settings.IfNothingFits != "ask" {
		settings.IfNothingFits = defaults.IfNothingFits
	}
	switch settings.Quality {
	case "best", "2160p", "1440p", "1080p", "720p", "480p":
	default:
		settings.Quality = defaults.Quality
	}
	if settings.PickMode != "choose" {
		settings.PickMode = "auto"
	}
	return settings
}

func Save(settings Settings) error {
	settings = Normalize(settings)
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath(), data, 0o644)
}

// ErrDisabled means the viewer has not opted into torrent streaming.
var ErrDisabled = errors.New("kuma is disabled")
