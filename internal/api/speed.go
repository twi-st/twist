package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// speedTest measures how fast this connection really is, so the player can pick
// a rendition the network can keep up with instead of always taking the highest
// one and buffering.
//
// It is a plain download of a random byte blob, capped at a small size: the
// measurement stops as soon as enough bytes or time have passed, so a fast link
// does not waste a full file. When the link is so fast that the first probe
// finishes before it can be timed meaningfully, the blob is doubled and the
// probe repeated, up to a hard ceiling. Nothing runs while the viewer is idle or
// paused: the frontend starts and stops it around playback.
type SpeedTest struct {
	mu        sync.Mutex
	samples   []float64
	megabits  float64
	measured  int64
	lastRun   time.Time
	running   bool
	endpoint  string
	client    *http.Client
	userAgent string
}

// SpeedResult is the current estimate plus what it was measured from.
type SpeedResult struct {
	Mbps      float64 `json:"mbps"`
	Bytes     int64   `json:"bytes"`
	At        int64   `json:"at"`
	Samples   int     `json:"samples"`
	ProbeSize int64   `json:"probeSize"`
}

const (
	speedProbeFloor = 5 << 20  // 5 MB: enough to time a slow link
	speedProbeCeil  = 80 << 20 // 80 MB: even a very fast link gets timed here
	speedProbeTime  = 6 * time.Second
	speedSampleKeep = 5
)

// speedTestEndpoint is a Cloudflare speed endpoint that returns N random bytes
// with no content negotiation, so the size can be chosen per request.
const speedTestEndpoint = "https://speed.cloudflare.com/__down?bytes=%d"

func newSpeedTest() *SpeedTest {
	return &SpeedTest{
		client: &http.Client{
			Timeout: 0,
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConns:        4,
				IdleConnTimeout:     30 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second,
			},
		},
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	}
}

// Measure runs one probe (growing the blob while the link outruns the timer)
// and folds the result into the running estimate. It is safe to call again
// while a measurement is in flight: the later call is a no-op.
func (s *SpeedTest) Measure(ctx context.Context) (SpeedResult, error) {
	s.mu.Lock()
	if s.running {
		result := s.resultLocked()
		s.mu.Unlock()
		return result, nil
	}
	s.running = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	size := int64(speedProbeFloor)
	var best float64
	var total int64
	start := time.Now()
	for size <= speedProbeCeil {
		mbps, bytes, err := s.probe(ctx, size)
		if err != nil {
			if best > 0 {
				break
			}
			return s.Result(), err
		}
		best = mbps
		total += bytes
		// A download that finished inside a fraction of the window was never
		// actually timed: the result is a lower bound (often limited by the
		// first packets, not the link). Double the blob and measure again.
		if bytes >= size && time.Since(start) < speedProbeTime/3 {
			size *= 2
			continue
		}
		break
	}

	s.mu.Lock()
	s.samples = append(s.samples, best)
	if len(s.samples) > speedSampleKeep {
		s.samples = s.samples[len(s.samples)-speedSampleKeep:]
	}
	s.megabits = median(s.samples)
	s.measured = total
	s.lastRun = time.Now()
	result := s.resultLocked()
	s.mu.Unlock()
	return result, nil
}

// probe downloads `size` bytes (or as much as the time window allows) and
// returns the measured throughput.
func (s *SpeedTest) probe(ctx context.Context, size int64) (float64, int64, error) {
	probeCtx, cancel := context.WithTimeout(ctx, speedProbeTime)
	defer cancel()

	target := fmt.Sprintf(speedTestEndpoint, size)
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("user-agent", s.userAgent)
	// A cache hit would measure the disk, not the network.
	req.Header.Set("cache-control", "no-cache")
	req.Header.Set("pragma", "no-cache")

	start := time.Now()
	res, err := s.client.Do(req)
	if err != nil {
		if probeCtx.Err() != nil && errors.Is(probeCtx.Err(), context.DeadlineExceeded) && time.Since(start) >= speedProbeTime {
			return 0, 0, fmt.Errorf("speed test timed out")
		}
		return 0, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return 0, 0, fmt.Errorf("speed test HTTP %d", res.StatusCode)
	}

	// Skip the TLS/connection setup from the transfer timing.
	first := time.Now()
	bytes, _ := io.Copy(io.Discard, res.Body)
	elapsed := time.Since(first)
	if elapsed <= 0 {
		elapsed = time.Millisecond
	}
	mbps := float64(bytes*8) / elapsed.Seconds() / 1e6
	return mbps, bytes, nil
}

// Result is the latest estimate (zero before the first measurement).
func (s *SpeedTest) Result() SpeedResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resultLocked()
}

func (s *SpeedTest) resultLocked() SpeedResult {
	result := SpeedResult{
		Mbps:    s.megabits,
		Bytes:   s.measured,
		Samples: len(s.samples),
	}
	if !s.lastRun.IsZero() {
		result.At = s.lastRun.UnixMilli()
	}
	return result
}

// RecommendedHeight maps the measured bandwidth onto the tallest rendition the
// link can sustain with headroom for the rest of the app. `bitrates` maps a
// label ("1080p") to its advertised bits per second.
func (s *SpeedTest) RecommendedHeight(bitrates map[string]int) string {
	result := s.Result()
	if result.Samples == 0 || result.Mbps <= 0 {
		return ""
	}
	// Keep a third of the link free: the player also fetches segments ahead,
	// subtitles and artwork.
	budget := result.Mbps * 1e6 * 0.65

	best := ""
	bestHeight := 0
	for label, bandwidth := range bitrates {
		if bandwidth <= 0 || float64(bandwidth) > budget {
			continue
		}
		height := heightOf(label)
		if height > bestHeight {
			best, bestHeight = label, height
		}
	}
	return best
}

func heightOf(label string) int {
	var height int
	for index := 0; index < len(label); index++ {
		char := label[index]
		if char < '0' || char > '9' {
			break
		}
		height = height*10 + int(char-'0')
	}
	return height
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted[len(sorted)/2]
}
