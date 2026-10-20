package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

type Settings struct {
	CacheEnabled           bool   `json:"cacheEnabled"`
	CacheMaxMB             int64  `json:"cacheMaxMB"`
	DownloadsDir           string `json:"downloadsDir"`
	MaxConcurrentDownloads int    `json:"maxConcurrentDownloads"`
	// Player selects where episodes play: "builtin", "vlc", "mpv" or "system".
	Player string `json:"player"`
}

func Default() Settings {
	return Settings{
		CacheEnabled:           true,
		CacheMaxMB:             4096,
		DownloadsDir:           defaultDownloadsDir(),
		MaxConcurrentDownloads: 2,
		Player:                 "builtin",
	}
}

func defaultDownloadsDir() string {
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		return filepath.Join(home, "Downloads", "Twist")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "twist-downloads")
	}
	return filepath.Join(dir, "Twist", "downloads")
}

func configDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Twist"), nil
}

func settingsPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

func Load() (Settings, error) {
	settings := Default()
	path, err := settingsPath()
	if err != nil {
		return settings, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return settings, nil
		}
		return settings, err
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return Default(), err
	}
	return Normalize(settings), nil
}

func Normalize(settings Settings) Settings {
	defaults := Default()
	if settings.CacheMaxMB < 128 {
		settings.CacheMaxMB = defaults.CacheMaxMB
	}
	if settings.MaxConcurrentDownloads < 1 || settings.MaxConcurrentDownloads > 6 {
		settings.MaxConcurrentDownloads = defaults.MaxConcurrentDownloads
	}
	if settings.DownloadsDir == "" {
		settings.DownloadsDir = defaults.DownloadsDir
	}
	switch settings.Player {
	case "builtin", "vlc", "mpv", "system":
	default:
		settings.Player = defaults.Player
	}
	return settings
}

func Save(settings Settings) error {
	settings = Normalize(settings)
	path, err := settingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func (s Settings) CacheDir() string {
	dir, err := configDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "twist-cache")
	}
	return filepath.Join(dir, "cache")
}

func Platform() string {
	return runtime.GOOS
}
