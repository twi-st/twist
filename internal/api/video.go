package api

import (
	"os"
	"runtime"
	"strings"
)

// VideoStatus describes the graphics stack the webview renders on.
//
// It exists because RTX Video Super Resolution is invisible from inside the
// page: the driver only engages it when the WebView2 GPU process runs on the
// NVIDIA adapter, and a hybrid laptop puts that process on the integrated GPU
// unless Chromium is told otherwise. Reporting the adapter names and the flags
// the app passed makes that diagnosable instead of guesswork.
type VideoStatus struct {
	Platform string `json:"platform"`
	// Adapters are the display adapters Windows reports (WMI).
	Adapters []string `json:"adapters"`
	// HighPerformanceGPU is whether the app asked Chromium for the dGPU.
	HighPerformanceGPU bool `json:"highPerformanceGpu"`
	// WebViewArgs are the Chromium flags the app passed to WebView2.
	WebViewArgs []string `json:"webviewArgs"`
	// SuperResolution explains what the user must do on their side.
	SuperResolution string `json:"superResolution"`
}

// VideoStatus reports the graphics stack (see the type for why).
func (s *Service) VideoStatus() VideoStatus {
	status := VideoStatus{
		Platform:           runtime.GOOS,
		Adapters:           displayAdapters(),
		HighPerformanceGPU: true,
		WebViewArgs:        webviewArgs(),
	}
	nvidia := false
	for _, adapter := range status.Adapters {
		if strings.Contains(strings.ToLower(adapter), "nvidia") {
			nvidia = true
			break
		}
	}
	switch {
	case !nvidia:
		status.SuperResolution = "No NVIDIA adapter was found; RTX Video Super Resolution needs an RTX GPU."
	case len(status.Adapters) > 1:
		status.SuperResolution = "Hybrid graphics detected. The app asks Chromium for the high-performance GPU; if the NVIDIA app still shows Super Resolution as inactive, set this app to High performance in Windows Graphics settings and restart it."
	default:
		status.SuperResolution = "RTX Video Super Resolution is enabled in the NVIDIA app (System > Video). It only engages while a video is playing and only upscales below the display's resolution."
	}
	return status
}

// webviewArgs mirrors the flags set in main.go.
func webviewArgs() []string {
	args := []string{"--force_high_performance_gpu"}
	if port := os.Getenv("TWIST_DEBUG_PORT"); port != "" {
		args = append(args, "--remote-debugging-port="+port)
	}
	return args
}
