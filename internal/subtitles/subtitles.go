package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Subtitle catalogue.
//
// Everything comes from OpenSubtitles v3, which indexes anime by IMDb id, so
// the MAL→IMDb mapping from ani.zip is resolved first and cached per title.
//
// Anime Kitsu was tried as a second source and dropped: it is a thin proxy in
// front of the same OpenSubtitles catalogue and returns byte-identical results,
// so listing both only duplicated every track in the menu.

const (
	openSubtitlesBase = "https://opensubtitles-v3.strem.io"
	mappingsBase      = "https://api.ani.zip/mappings"
)

// Track is one subtitle file offered for an episode.
type Track struct {
	URL      string `json:"url"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Default  bool   `json:"default"`
	// Source names the catalogue ("kitsu", "opensubtitles") so the UI can
	// group them; the mirror's own tracks use "".
	Source string `json:"source,omitempty"`
}

// Source identifies one catalogue the viewer can load on demand.
type Source struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type addonResponse struct {
	Subtitles []struct {
		ID               string `json:"id"`
		URL              string `json:"url"`
		Lang             string `json:"lang"`
		SubtitleFileName string `json:"subtitleFileName"`
		MovieReleaseName string `json:"movieReleaseName"`
		ReleaseGroup     string `json:"releaseGroup"`
	} `json:"subtitles"`
}

var httpClient = &http.Client{
	Timeout: 20 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          8,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
	},
}

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// Fetch returns the tracks from one catalogue. `source` is "opensubtitles".
func Fetch(ctx context.Context, source string, malID, episode int) ([]Track, error) {
	switch source {
	case "opensubtitles", "":
		return fetchOpenSubtitles(ctx, malID, episode)
	}
	return nil, fmt.Errorf("unknown subtitle source %q", source)
}

// Catalogues lists the available extra sources with their track counts, so the
// subtitle menu can show what each one offers before it is opened.
func Catalogues(ctx context.Context, malID, episode int) []Source {
	tracks, err := fetchOpenSubtitles(ctx, malID, episode)
	if err != nil || len(tracks) == 0 {
		return nil
	}
	return []Source{{ID: "opensubtitles", Name: "OpenSubtitles", Count: len(tracks)}}
}

func fetchOpenSubtitles(ctx context.Context, malID, episode int) ([]Track, error) {
	imdb, err := imdbForMAL(ctx, malID)
	if err != nil || imdb == "" {
		// No IMDb id means this title is not in that catalogue.
		return nil, nil
	}
	target := fmt.Sprintf("%s/subtitles/series/%s:%d:%d.json", openSubtitlesBase, imdb, episode, episode)
	entries, err := fetchAddon(ctx, target)
	if err != nil {
		return nil, err
	}
	return toTracks(entries, "opensubtitles"), nil
}

func fetchAddon(ctx context.Context, target string) ([]struct {
	ID               string `json:"id"`
	URL              string `json:"url"`
	Lang             string `json:"lang"`
	SubtitleFileName string `json:"subtitleFileName"`
	MovieReleaseName string `json:"movieReleaseName"`
	ReleaseGroup     string `json:"releaseGroup"`
}, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", userAgent)
	res, err := httpClient.Do(req)
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
	var payload addonResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return payload.Subtitles, nil
}

// toTracks normalises, labels and orders one catalogue's entries.
func toTracks(entries []struct {
	ID               string `json:"id"`
	URL              string `json:"url"`
	Lang             string `json:"lang"`
	SubtitleFileName string `json:"subtitleFileName"`
	MovieReleaseName string `json:"movieReleaseName"`
	ReleaseGroup     string `json:"releaseGroup"`
}, source string) []Track {
	tracks := make([]Track, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.URL == "" || seen[entry.URL] {
			continue
		}
		seen[entry.URL] = true
		language := NormalizeLanguage(entry.Lang)
		tracks = append(tracks, Track{
			URL:      entry.URL,
			Label:    label(entry.MovieReleaseName, entry.SubtitleFileName, entry.ReleaseGroup, language),
			Language: language,
			Default:  language == "en",
			Source:   source,
		})
	}
	sort.SliceStable(tracks, func(i, j int) bool {
		if tracks[i].Default != tracks[j].Default {
			return tracks[i].Default
		}
		if tracks[i].Language != tracks[j].Language {
			return tracks[i].Language < tracks[j].Language
		}
		return tracks[i].Label < tracks[j].Label
	})
	if len(tracks) > 80 {
		tracks = tracks[:80]
	}
	return tracks
}

// NormalizeLanguage maps ISO 639-2 codes (what the addons send) onto 639-1,
// which is what <track srcLang> and the player preference expect.
func NormalizeLanguage(code string) string {
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

// label prefers the release name (two English tracks from different groups are
// timed differently), then the file name, then the group, then the language.
func label(releaseName, fileName, group, language string) string {
	for _, candidate := range []string{releaseName, fileName} {
		value := strings.TrimSpace(candidate)
		if value == "" {
			continue
		}
		if group != "" && !strings.Contains(value, group) {
			value += " [" + group + "]"
		}
		if len(value) > 64 {
			value = value[:61] + "..."
		}
		return value
	}
	return strings.ToUpper(language)
}

/* --------------------------------------------------------------------------
 * MAL → IMDb
 *
 * OpenSubtitles only indexes IMDb ids. ani.zip publishes the mapping for every
 * anime it knows; titles it does not cover (older shows such as Naruto) have
 * no IMDb id there, and those simply do not appear in the OpenSubtitles list.
 * Results are cached in memory: one lookup per title per session.
 * ----------------------------------------------------------------------- */

var (
	imdbMu    sync.Mutex
	imdbCache = map[int]imdbEntry{}
)

type imdbEntry struct {
	id      string
	expires time.Time
}

const imdbCacheTTL = 12 * time.Hour

func imdbForMAL(ctx context.Context, malID int) (string, error) {
	imdbMu.Lock()
	if entry, ok := imdbCache[malID]; ok && time.Now().Before(entry.expires) {
		imdbMu.Unlock()
		return entry.id, nil
	}
	imdbMu.Unlock()

	target := fmt.Sprintf("%s?mal_id=%d", mappingsBase, malID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("user-agent", userAgent)
	res, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("mappings: HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return "", err
	}
	match := imdbPattern.FindSubmatch(data)
	id := ""
	if len(match) == 2 {
		id = string(match[1])
	}

	imdbMu.Lock()
	imdbCache[malID] = imdbEntry{id: id, expires: time.Now().Add(imdbCacheTTL)}
	imdbMu.Unlock()
	return id, nil
}

var imdbPattern = regexp.MustCompile(`"imdb_id"\s*:\s*"([^"]+)"`)

/* --------------------------------------------------------------------------
 * SRT → WebVTT
 *
 * The addons serve SRT. A <track> element only accepts WebVTT, so the relay
 * converts on the fly when a subtitle file is fetched.
 * ----------------------------------------------------------------------- */

// srtToVTT rewrites SubRip cues into WebVTT: a header, `,` decimal separators
// and cue numbers dropped. Timestamps, alignment and text are otherwise left
// exactly as the author wrote them.
func srtToVTT(input string) string {
	text := strings.ReplaceAll(input, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimPrefix(text, "\ufeff")

	var out strings.Builder
	out.WriteString("WEBVTT\n\n")

	cueIndex := regexp.MustCompile(`^\d+$`)
	lines := strings.Split(text, "\n")
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		// A cue number is only a number on its own line and followed by a
		// timing line; dropping any bare number would eat dialogue like "42".
		if cueIndex.MatchString(strings.TrimSpace(line)) {
			next := index + 1
			for next < len(lines) && strings.TrimSpace(lines[next]) == "" {
				next++
			}
			if next < len(lines) && strings.Contains(lines[next], "-->") {
				continue
			}
		}
		if strings.Contains(line, "-->") {
			line = strings.ReplaceAll(line, ",", ".")
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	return out.String()
}

// LooksLikeSRT reports whether a payload is SubRip rather than WebVTT.
func LooksLikeSRT(body string) bool {
	trimmed := strings.TrimSpace(strings.TrimPrefix(body, "\ufeff"))
	if strings.HasPrefix(trimmed, "WEBVTT") {
		return false
	}
	return strings.Contains(trimmed, "-->")
}

// ConvertSRT is the exported entry point used by the relay.
func ConvertSRT(body string) string { return srtToVTT(body) }

