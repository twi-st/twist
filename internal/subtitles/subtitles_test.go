package subtitles

import (
	"testing"
)

// TestSRTConversion checks the SubRip → WebVTT rewrite, including dialogue
// lines that are just a number.
func TestSRTConversion(t *testing.T) {
	input := "\ufeff1\r\n00:00:02,630 --> 00:00:04,670\r\n<i>Wealth, fame, power...</i>\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\n42\r\n\r\n"
	if !LooksLikeSRT(input) {
		t.Fatal("SRT not recognised")
	}
	output := ConvertSRT(input)
	if output[:6] != "WEBVTT" {
		t.Fatalf("missing WEBVTT header: %q", output[:20])
	}
	if contains(output, ",") && !contains(output, "Wealth, fame") {
		t.Fatalf("timestamp comma not converted: %q", output)
	}
	if !contains(output, "00:00:02.630 --> 00:00:04.670") {
		t.Fatalf("timestamps wrong: %q", output)
	}
	// A dialogue line that is only a number must survive.
	if !contains(output, "\n42\n") {
		t.Fatalf("numeric dialogue line was eaten: %q", output)
	}
	// Cue numbers must be gone.
	if contains(output, "\n1\n") || contains(output, "\n2\n") {
		t.Fatalf("cue numbers survived: %q", output)
	}
	if LooksLikeSRT(output) {
		t.Fatal("converted output still looks like SRT")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
