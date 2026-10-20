package providers

import (
	"net/url"
	"strings"
)

// labelOr keeps a readable subtitle label when the provider sends none.
func labelOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// normalizeRange drops empty or inverted markers.
func normalizeRange(value *Range) *Range {
	if value == nil || value.End <= value.Start {
		return nil
	}
	return value
}

// guessLanguage maps a track label or file name onto an ISO code.
func guessLanguage(label, file string) string {
	languages := map[string]string{
		"arabic": "ar", "english": "en", "french": "fr", "german": "de",
		"italian": "it", "portuguese": "pt", "russian": "ru", "spanish": "es",
	}
	cleaned := strings.ToLower(strings.TrimSpace(strings.Split(label, "(")[0]))
	if code, ok := languages[cleaned]; ok {
		return code
	}
	if parsed, err := url.Parse(file); err == nil {
		name := parsed.Path[strings.LastIndex(parsed.Path, "/")+1:]
		name = strings.TrimSuffix(name, ".vtt")
		name = strings.Split(name, "-")[0]
		if code, ok := languages[name]; ok {
			return code
		}
		if name != "" {
			return name
		}
	}
	return "en"
}
