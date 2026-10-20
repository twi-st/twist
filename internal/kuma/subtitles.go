package kuma

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Subtitle sources.
//
// Torrentio only supplies stream links; subtitles come from the Stremio
// subtitle addons, which are keyless and key episodes the same way. The Anime
// Kitsu addon accepts `mal:<id>:<episode>` directly, which is what this app
// already has, so no id mapping is needed.
const subtitleAddonBase = "https://anime-kitsu.strem.fun"

// SubtitleTrack is one subtitle file offered for the episode.
type SubtitleTrack struct {
	URL      string `json:"url"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Default  bool   `json:"default"`
}

type subtitleResponse struct {
	Subtitles []struct {
		ID               string `json:"id"`
		URL              string `json:"url"`
		Lang             string `json:"lang"`
		SubtitleFileName string `json:"subtitleFileName"`
		MovieReleaseName string `json:"movieReleaseName"`
	} `json:"subtitles"`
}

// Subtitles fetches the subtitle list for an episode. Dub and sub share the same
// file set: the addon keys on the episode, not the audio track.
func Subtitles(ctx context.Context, malID, episode int) ([]SubtitleTrack, error) {
	target := fmt.Sprintf("%s/subtitles/series/mal:%d:%d.json", subtitleAddonBase, malID, episode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", userAgent)
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("subtitles: HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var payload subtitleResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}

	tracks := make([]SubtitleTrack, 0, len(payload.Subtitles))
	for _, entry := range payload.Subtitles {
		if entry.URL == "" {
			continue
		}
		language := normalizeLanguage(entry.Lang)
		tracks = append(tracks, SubtitleTrack{
			URL:      entry.URL,
			Label:    subtitleLabel(entry.SubtitleFileName, entry.MovieReleaseName, language),
			Language: language,
			// English is what the player starts with when the preference is
			// "auto"; every other language stays listed but off.
			Default: language == "en",
		})
	}
	// English first, then the rest alphabetically: the menu is long and the
	// useful entries should not be buried.
	sort.SliceStable(tracks, func(i, j int) bool {
		if tracks[i].Default != tracks[j].Default {
			return tracks[i].Default
		}
		if tracks[i].Language != tracks[j].Language {
			return tracks[i].Language < tracks[j].Language
		}
		return tracks[i].Label < tracks[j].Label
	})
	if len(tracks) > 60 {
		tracks = tracks[:60]
	}
	return tracks, nil
}

// normalizeLanguage maps the addon's ISO 639-2 codes to 639-1, which is what
// <track srcLang> and the player's preference expect.
func normalizeLanguage(code string) string {
	lower := strings.ToLower(strings.TrimSpace(code))
	if mapped, ok := languageCodes[lower]; ok {
		return mapped
	}
	if len(lower) >= 2 {
		return lower[:2]
	}
	return "en"
}

var languageCodes = map[string]string{
	"eng": "en", "jpn": "ja", "spa": "es", "fre": "fr", "fra": "fr", "ger": "de",
	"deu": "de", "ita": "it", "por": "pt", "pob": "pt-BR", "rus": "ru", "ara": "ar",
	"chi": "zh", "zho": "zh", "kor": "ko", "dut": "nl", "nld": "nl", "pol": "pl",
	"tur": "tr", "swe": "sv", "nor": "no", "dan": "da", "fin": "fi", "cze": "cs",
	"ces": "cs", "hun": "hu", "rum": "ro", "ron": "ro", "gre": "el", "ell": "el",
	"ukr": "uk", "vie": "vi", "tha": "th", "ind": "id", "may": "ms", "msa": "ms",
	"heb": "he", "hin": "hi", "ben": "bn", "tam": "ta", "tel": "te", "fil": "fil",
	"tgl": "fil", "hrv": "hr", "srp": "sr", "slv": "sl", "bul": "bg", "cat": "ca",
	"est": "et", "lav": "lv", "lit": "lt", "slo": "sk", "slk": "sk", "per": "fa",
	"fas": "fa", "urd": "ur", "mal": "ml", "kan": "kn", "mar": "mr", "guj": "gu",
	"pan": "pa", "mya": "my", "khm": "km", "lao": "lo", "nep": "ne", "sin": "si",
	"alb": "sq", "sqi": "sq", "mac": "mk", "mkd": "mk", "bos": "bs", "geo": "ka",
	"kat": "ka", "arm": "hy", "hye": "hy", "aze": "az", "kaz": "kk", "uzb": "uz",
}

// subtitleLabel prefers the release name, which tells two English tracks apart
// (different groups time their files differently), and falls back to the file
// name and then the language code.
func subtitleLabel(fileName, releaseName, language string) string {
	for _, candidate := range []string{releaseName, fileName} {
		value := strings.TrimSpace(candidate)
		if value == "" {
			continue
		}
		if len(value) > 60 {
			value = value[:57] + "..."
		}
		return value
	}
	return strings.ToUpper(language)
}

