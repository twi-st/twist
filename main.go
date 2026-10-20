package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"twisted/internal/api"
	"twisted/internal/cache"
	"twisted/internal/config"
	"twisted/internal/downloads"
	"twisted/internal/proxy"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	settings, err := config.Load()
	if err != nil {
		log.Printf("could not load settings, using defaults: %v", err)
		settings = config.Default()
	}

	diskCache, err := cache.New(settings.CacheDir(), settings.CacheEnabled, settings.CacheMaxMB)
	if err != nil {
		log.Printf("cache unavailable: %v", err)
	}

	relay, err := proxy.New(diskCache, settings.CacheEnabled)
	if err != nil {
		log.Fatalf("could not start local relay: %v", err)
	}

	manager := downloads.New(settings.DownloadsDir)
	relay.SetDownloadHandler(manager)
	// Serve proxied media from the app's own origin: the webview refuses
	// cross-origin subtitle <track> elements and some media requests.
	relay.SetPrefix("/relay")
	system := api.New(settings, diskCache, relay, manager)
	// The downloads page needs the same-origin base for local playback.
	system.SetRelayBase("/relay")
	// TWIST_DEBUG_PORT opens WebView2's DevTools endpoint, which is how the
	// player can be inspected end-to-end without a visible console.
	windowsOptions := application.WindowsOptions{}
	// Hybrid-graphics laptops (Intel/AMD iGPU + NVIDIA dGPU) put the WebView2
	// GPU process on the integrated GPU by default. NVIDIA RTX Video Super
	// Resolution and RTX HDR only run on the discrete GPU, and neither the
	// Windows "high performance" preference nor NvOptimusEnablement reaches the
	// WebView2 GPU process, so the flag has to be passed to Chromium directly.
	// Supported from WebView2 145; older runtimes ignore it.
	browserArgs := []string{"--force_high_performance_gpu"}
	if port := os.Getenv("TWIST_DEBUG_PORT"); port != "" {
		browserArgs = append(browserArgs, "--remote-debugging-port="+port)
	}
	windowsOptions.AdditionalBrowserArgs = browserArgs

	app := application.New(application.Options{
		Name:        "Twist",
		Windows:     windowsOptions,
		Description: "Ad-free anime streaming and discussion",
		Services: []application.Service{
			application.NewService(system),
		},
		Assets: application.AssetOptions{
			Handler: assetHandler(assets),
			// The runtime asks for /wails/custom.js and a few helper endpoints;
			// the embedded SPA would answer them with index.html (or a 404 in
			// dev) unless the framework's own middleware sees them first.
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasPrefix(r.URL.Path, "/relay/") {
						relay.ServeHTTP(w, r)
						return
					}
					if strings.HasPrefix(r.URL.Path, "/kuma/") {
						relay.ServeHTTP(w, r)
						return
					}
					if strings.HasPrefix(r.URL.Path, "/wails/") {
						if r.URL.Path == "/wails/custom.js" {
							w.Header().Set("content-type", "application/javascript")
							w.WriteHeader(http.StatusOK)
							return
						}
						next.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		OnShutdown: func() {
			manager.Shutdown()
			relay.Close()
		},
	})

	// Push download progress/status to the frontend as it happens, so pause,
	// resume and percentages do not wait for a poll.
	manager.SetChangeHandler(func(item downloads.Item) {
		app.Event.Emit("twist:download", item)
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Twist",
		Width:            1280,
		Height:           860,
		MinWidth:         900,
		MinHeight:        600,
		Frameless:        true,
		BackgroundColour: application.NewRGB(29, 31, 34),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Printf("twist exited: %v", err)
		os.Exit(1)
	}
}

// assetHandler serves the embedded bundle with SPA fallback, while leaving
// Wails' own routes (/wails/runtime.js, the IPC endpoint, ...) untouched.
// Under `wails3 dev` the framework proxies to Vite before this is reached.
func assetHandler(bundle embed.FS) http.Handler {
	spa := spaHandler(bundle)
	bundled := application.BundledAssetFileServer(bundle)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/wails/") {
			bundled.ServeHTTP(w, r)
			return
		}
		spa.ServeHTTP(w, r)
	})
}

// spaHandler serves the built frontend and falls back to index.html so
// client-side routes survive a reload or a direct link.
func spaHandler(bundle embed.FS) http.Handler {
	root, err := fs.Sub(bundle, "frontend/dist")
	if err != nil {
		return http.NotFoundHandler()
	}
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleaned := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleaned == "" || cleaned == "." {
			cleaned = "index.html"
		}
		if info, err := fs.Stat(root, cleaned); err == nil && !info.IsDir() {
			if strings.HasPrefix(cleaned, "assets/") {
				w.Header().Set("cache-control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		if path.Ext(cleaned) != "" {
			http.NotFound(w, r)
			return
		}
		index, err := fs.ReadFile(root, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})
}
