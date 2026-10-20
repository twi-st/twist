package proxy

import (
	"strings"
	"testing"

	"twisted/internal/subtitles"
)

// TestSubtitleConversion covers the relay path: a SubRip payload fetched from
// an addon must come back as WebVTT, which is the only thing <track> accepts.
func TestSubtitleConversion(t *testing.T) {
	srt := "\ufeff1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\n\r\n" +
		"2\r\n00:00:04,000 --> 00:00:06,000\r\n42\r\n\r\n" +
		"3\r\n00:00:07,000 --> 00:00:09,000\r\n<i>Second line</i>\r\nsecond row\r\n"

	if !looksLikeSubtitle("application/x-subrip; charset=utf-8", "/en/download/file/1") {
		t.Fatal("x-subrip not detected as a subtitle")
	}
	if !looksLikeSubtitle("text/plain", "/subs/file.srt") {
		t.Fatal(".srt path not detected as a subtitle")
	}
	if looksLikeSubtitle("video/mp2t", "/seg00001.ts") {
		t.Fatal("a segment was misdetected as a subtitle")
	}
	if looksLikeSubtitle("application/vnd.apple.mpegurl", "/master.m3u8") {
		t.Fatal("a playlist was misdetected as a subtitle")
	}

	out := subtitles.ConvertSRT(srt)
	if !strings.HasPrefix(out, "WEBVTT") {
		t.Fatalf("missing WEBVTT header: %q", out)
	}
	if !strings.Contains(out, "00:00:01.000 --> 00:00:03.500") {
		t.Fatalf("timestamps not converted: %q", out)
	}
	if !strings.Contains(out, "\n42\n") {
		t.Fatalf("numeric dialogue lost: %q", out)
	}
	if !strings.Contains(out, "second row") {
		t.Fatalf("multi-line cue lost: %q", out)
	}
}
