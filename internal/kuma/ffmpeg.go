package kuma

import (
	"archive/tar"
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ulikunitz/xz"
)

// DownloadFFmpeg fetches a static ffmpeg build into the app's own bin folder
// and returns its status. The archive is never bundled with the app; this is
// the explicit opt-in for machines that do not already have ffmpeg.
func DownloadFFmpeg(ctx context.Context, progress func(string)) (FFmpegStatus, error) {
	target, err := FFmpegDownloadURL()
	if err != nil {
		return FFmpegStatus{}, err
	}
	dest := managedFFmpegPath()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return FFmpegStatus{}, err
	}

	if progress != nil {
		progress("downloading ffmpeg")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return FFmpegStatus{}, err
	}
	req.Header.Set("user-agent", userAgent)
	res, err := (&http.Client{Timeout: 0}).Do(req)
	if err != nil {
		return FFmpegStatus{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return FFmpegStatus{}, fmt.Errorf("download failed: HTTP %d", res.StatusCode)
	}

	if progress != nil {
		progress("extracting")
	}
	if strings.HasSuffix(target, ".zip") {
		err = extractZipFFmpeg(res.Body, filepath.Dir(dest), filepath.Base(dest))
	} else {
		err = extractTarXzFFmpeg(res.Body, filepath.Dir(dest), filepath.Base(dest))
	}
	if err != nil {
		return FFmpegStatus{}, err
	}

	if runtime.GOOS != "windows" {
		_ = os.Chmod(dest, 0o755)
	}
	status := probeFFmpeg(dest, true)
	if !status.Available {
		return status, fmt.Errorf("downloaded ffmpeg did not run")
	}
	return status, nil
}

// extractZipFFmpeg copies the first matching executable out of a zip archive.
func extractZipFFmpeg(body io.Reader, destDir, destName string) error {
	temp, err := os.CreateTemp("", "ffmpeg-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := io.Copy(temp, body); err != nil {
		return err
	}
	archive, err := zip.OpenReader(temp.Name())
	if err != nil {
		return err
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if filepath.Base(entry.Name) != destName {
			continue
		}
		return writeEntry(entry.Open, filepath.Join(destDir, destName))
	}
	return fmt.Errorf("ffmpeg executable not found in archive")
}

// extractTarXzFFmpeg does the same for the static Linux build.
func extractTarXzFFmpeg(body io.Reader, destDir, destName string) error {
	reader, err := xz.NewReader(body)
	if err != nil {
		return err
	}
	archive := tar.NewReader(reader)
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(header.Name) != destName {
			continue
		}
		return writeEntry(func() (io.ReadCloser, error) { return io.NopCloser(archive), nil }, filepath.Join(destDir, destName))
	}
	return fmt.Errorf("ffmpeg executable not found in archive")
}

func writeEntry(open func() (io.ReadCloser, error), dest string) error {
	source, err := open()
	if err != nil {
		return err
	}
	defer source.Close()
	file, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, source); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
