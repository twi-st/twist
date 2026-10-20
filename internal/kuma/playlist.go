package kuma

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// playlistWriter publishes Kuma episodes as finished videos instead of live
// streams.
//
// hls.js only leaves "live" mode when it sees #EXT-X-ENDLIST, and a live
// playlist has no duration and starts at the live edge. ffmpeg's own HLS muxer
// cannot end a playlist before the episode is fully muxed, so it only writes
// segments (`-hls_playlist_type event`, `temp_file` for atomic writes) and this
// type publishes the playlist the player sees:
//
//   - When the episode's duration is known, the full VOD playlist is written
//     immediately, listing every segment and ending with #EXT-X-ENDLIST. The
//     player sees a normal episode with its real duration and can seek anywhere;
//     segment requests for parts that are still downloading wait for the bytes
//     (see Engine.Handler) instead of failing.
//   - When the duration cannot be probed (some containers do not carry one),
//     the playlist grows with the segments and ENDLIST is appended at the end.
type playlistWriter struct {
	dir     string
	segment int
	total   float64

	mu       sync.Mutex
	complete bool
	written  bool
}

func newPlaylistWriter(dir string, segmentSeconds int, duration float64) *playlistWriter {
	if segmentSeconds < 2 {
		segmentSeconds = 6
	}
	return &playlistWriter{dir: dir, segment: segmentSeconds, total: duration}
}

// Watch republishes ffmpeg's playlist until the context is cancelled.
func (w *playlistWriter) Watch(ctx context.Context, source string) {
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			w.refresh(source, true)
			return
		case <-ticker.C:
			w.refresh(source, false)
		}
	}
}

func (w *playlistWriter) refresh(source string, done bool) {
	if done {
		w.mu.Lock()
		w.complete = true
		w.mu.Unlock()
	}
	// A known duration means the playlist is final from the first write: every
	// segment is listed up front, so there is nothing to re-read or re-publish.
	if w.total > 0 {
		w.mu.Lock()
		written := w.written
		w.mu.Unlock()
		if !written {
			_ = w.writeFull()
		}
		return
	}

	data, err := os.ReadFile(source)
	if err != nil {
		return
	}
	segments, complete := parsePlaylist(string(data))
	if len(segments) == 0 {
		return
	}
	w.mu.Lock()
	w.complete = w.complete || complete
	w.mu.Unlock()
	_ = w.writeGrowing(segments)
}

// writeFull publishes the whole episode as a VOD playlist up front.
func (w *playlistWriter) writeFull() error {
	count := int(w.total / float64(w.segment))
	if count < 1 {
		count = 1
	}
	// ffmpeg cuts on keyframes, so real segments are at least `segment` long.
	// The last one carries the remainder.
	last := w.total - float64(count*w.segment)
	if last < float64(w.segment) {
		last = float64(w.segment)
	}

	var builder strings.Builder
	builder.WriteString("#EXTM3U\n#EXT-X-VERSION:6\n")
	fmt.Fprintf(&builder, "#EXT-X-TARGETDURATION:%d\n", w.segment)
	builder.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	builder.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	builder.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index := 0; index < count; index++ {
		fmt.Fprintf(&builder, "#EXTINF:%.3f,\n", float64(w.segment))
		fmt.Fprintf(&builder, "seg%05d.ts\n", index)
	}
	fmt.Fprintf(&builder, "#EXTINF:%.3f,\n", last)
	fmt.Fprintf(&builder, "seg%05d.ts\n", count)
	builder.WriteString("#EXT-X-ENDLIST\n")

	if err := w.publish(builder.String()); err != nil {
		return err
	}
	w.mu.Lock()
	w.written = true
	w.mu.Unlock()
	return nil
}

func (w *playlistWriter) writeGrowing(segments []float64) error {
	target := w.segment
	var builder strings.Builder
	builder.WriteString("#EXTM3U\n#EXT-X-VERSION:6\n")
	fmt.Fprintf(&builder, "#EXT-X-TARGETDURATION:%d\n", target)
	builder.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	builder.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	builder.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index, duration := range segments {
		fmt.Fprintf(&builder, "#EXTINF:%.3f,\n", duration)
		fmt.Fprintf(&builder, "seg%05d.ts\n", index)
	}
	w.mu.Lock()
	complete := w.complete
	w.mu.Unlock()
	if complete {
		builder.WriteString("#EXT-X-ENDLIST\n")
	}
	return w.publish(builder.String())
}

// publish renames the playlist into place so readers never see a partial file.
func (w *playlistWriter) publish(content string) error {
	final := filepath.Join(w.dir, "index.m3u8")
	temp := final + ".tmp"
	if err := os.WriteFile(temp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(temp, final)
}

// parsePlaylist extracts segment durations from an HLS media playlist.
func parsePlaylist(text string) ([]float64, bool) {
	var durations []float64
	pending := 0.0
	complete := false
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ",")
			if at := strings.IndexByte(value, ','); at >= 0 {
				value = value[:at]
			}
			pending, _ = strconv.ParseFloat(strings.TrimSpace(value), 64)
		case line == "#EXT-X-ENDLIST":
			complete = true
		case line != "" && !strings.HasPrefix(line, "#"):
			durations = append(durations, pending)
			pending = 0
		}
	}
	return durations, complete
}

// ffmpegSegmentCommand builds the demux→HLS command. Video is copied, never
// re-encoded, so playback starts as soon as the first pieces arrive.
//
// `audio` is the index of the audio stream to mux (0 = first). Dual-audio
// releases put Japanese first and the dub second, so taking stream 0 silently
// played the original audio with no way to tell; the engine picks the track that
// matches the requested sub/dub instead.
func ffmpegSegmentCommand(ctx context.Context, ffmpeg, input, dir string, segmentSeconds, audio int) *exec.Cmd {
	audioMap := "0:a:0?"
	if audio > 0 {
		audioMap = fmt.Sprintf("0:a:%d?", audio)
	}
	return exec.CommandContext(ctx, ffmpeg,
		"-hide_banner", "-loglevel", "error",
		// Small probes start playback sooner; the video below is copied.
		"-probesize", "2M", "-analyzeduration", "3M",
		"-i", input,
		"-map", "0:v:0", "-map", audioMap,
		"-c:v", "copy",
		"-c:a", "aac", "-b:a", "192k", "-ac", "2",
		"-f", "hls",
		"-hls_time", strconv.Itoa(segmentSeconds),
		"-hls_playlist_type", "event",
		"-hls_flags", "independent_segments+temp_file",
		"-hls_segment_filename", filepath.Join(dir, "seg%05d.ts"),
		filepath.Join(dir, "ffmpeg.m3u8"),
	)
}

// audioStream is one audio track ffmpeg found in the episode.
type audioStream struct {
	Index    int
	Language string
	Title    string
}

// probeAudio lists the audio tracks in the input.
func probeAudio(ctx context.Context, ffmpeg, input string, limit time.Duration) []audioStream {
	probeCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	output, _ := exec.CommandContext(probeCtx, ffmpeg,
		"-hide_banner",
		"-i", input,
	).CombinedOutput()
	var streams []audioStream
	for _, line := range strings.Split(string(output), "\n") {
		// Example:
		//   Stream #0:1(eng): Audio: aac (LC), 48000 Hz, stereo, fltp, 192 kb/s (default)
		//   Stream #0:2(jpn): Audio: aac, ... (title: Japanese)
		if !strings.Contains(line, "Audio:") || !strings.Contains(line, "Stream #") {
			continue
		}
		at := strings.Index(line, "Stream #")
		rest := line[at+len("Stream #"):]
		colon := strings.Index(rest, ":")
		if colon < 0 {
			continue
		}
		// "0:1(eng)" -> index 1, language eng
		parts := strings.SplitN(rest[:colon], ":", 2)
		if len(parts) != 2 {
			continue
		}
		index, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			continue
		}
		stream := audioStream{Index: index}
		if open := strings.Index(rest, "("); open >= 0 {
			if close := strings.Index(rest[open:], ")"); close > 0 {
				stream.Language = strings.TrimSpace(rest[open+1 : open+close])
			}
		}
		if title := strings.Index(line, "(title:"); title >= 0 {
			value := strings.TrimPrefix(line[title:], "(title:")
			stream.Title = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value), ")"))
		}
		streams = append(streams, stream)
	}
	return streams
}

// pickAudio chooses the audio stream for the requested track. Dual-audio anime
// releases are usually [jpn, eng]; the dub is the English (or second) track.
// With a single track it is used for both, since that is all that exists.
func pickAudio(streams []audioStream, kind string) int {
	if len(streams) <= 1 {
		return 0
	}
	wantDub := strings.EqualFold(kind, "dub")
	if wantDub {
		for index, stream := range streams {
			language := strings.ToLower(stream.Language)
			title := strings.ToLower(stream.Title)
			if language == "eng" || strings.Contains(title, "english") || strings.Contains(title, "dub") {
				return index
			}
		}
		// No English label: the second track is the dub in practice.
		return 1
	}
	for index, stream := range streams {
		language := strings.ToLower(stream.Language)
		title := strings.ToLower(stream.Title)
		if language == "jpn" || language == "ja" || strings.Contains(title, "japanese") || strings.Contains(title, "original") {
			return index
		}
	}
	return 0
}

// probeDuration asks ffmpeg for the input's duration. It reads only the header,
// so it is cheap for MKV and for MP4 with a leading moov atom; when the header
// carries no duration (or the probe takes too long) it gives up and the caller
// falls back to a growing playlist.
func probeDuration(ctx context.Context, ffmpeg, input string, limit time.Duration) (float64, error) {
	probeCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, ffmpeg,
		"-hide_banner",
		"-i", input,
		"-f", "null", "-",
	)
	output, _ := cmd.CombinedOutput()
	text := string(output)
	index := strings.LastIndex(text, "Duration:")
	if index < 0 {
		return 0, errors.New("duration not reported")
	}
	value := strings.TrimSpace(text[index+len("Duration:"):])
	if at := strings.IndexByte(value, ','); at >= 0 {
		value = value[:at]
	}
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("unexpected duration %q", value)
	}
	hours, _ := strconv.ParseFloat(parts[0], 64)
	minutes, _ := strconv.ParseFloat(parts[1], 64)
	seconds, _ := strconv.ParseFloat(parts[2], 64)
	total := hours*3600 + minutes*60 + seconds
	if total <= 0 {
		return 0, errors.New("duration is zero")
	}
	return total, nil
}
