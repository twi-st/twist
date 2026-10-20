package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Meta struct {
	Key         string `json:"key"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	Expires     int64  `json:"expires"`
	Used        int64  `json:"used"`
}

type Stats struct {
	Enabled bool  `json:"enabled"`
	Entries int   `json:"entries"`
	Bytes   int64 `json:"bytes"`
	MaxMB   int64 `json:"maxMb"`
}

type Cache struct {
	mu      sync.Mutex
	dir     string
	enabled bool
	max     int64
	entries map[string]Meta
	bytes   int64
}

func New(dir string, enabled bool, maxMB int64) (*Cache, error) {
	if maxMB < 1 {
		maxMB = 1024
	}
	c := &Cache{
		dir:     dir,
		enabled: enabled,
		max:     maxMB * 1024 * 1024,
		entries: map[string]Meta{},
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return c, err
	}
	c.load()
	return c, nil
}

func Key(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (c *Cache) Enabled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.enabled
}

func (c *Cache) SetEnabled(enabled bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.enabled = enabled
}

func (c *Cache) SetMaxMB(maxMB int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if maxMB < 1 {
		maxMB = 1
	}
	c.max = maxMB * 1024 * 1024
	c.evictLocked()
}

func (c *Cache) load() {
	data, err := os.ReadFile(filepath.Join(c.dir, "index.json"))
	if err != nil {
		return
	}
	var entries map[string]Meta
	if json.Unmarshal(data, &entries) != nil {
		return
	}
	now := time.Now().Unix()
	for key, meta := range entries {
		if meta.Expires <= now {
			os.Remove(filepath.Join(c.dir, key+".bin"))
			continue
		}
		if _, err := os.Stat(filepath.Join(c.dir, key+".bin")); err != nil {
			continue
		}
		c.entries[key] = meta
		c.bytes += meta.Size
	}
	c.evictLocked()
}

func (c *Cache) saveLocked() {
	data, err := json.Marshal(c.entries)
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(c.dir, "index.json"), data, 0o644)
}

func (c *Cache) Get(key string) ([]byte, string, bool) {
	c.mu.Lock()
	meta, ok := c.entries[key]
	if !ok {
		c.mu.Unlock()
		return nil, "", false
	}
	if meta.Expires <= time.Now().Unix() {
		c.removeLocked(key, meta)
		c.mu.Unlock()
		return nil, "", false
	}
	meta.Used = time.Now().Unix()
	c.entries[key] = meta
	path := filepath.Join(c.dir, key+".bin")
	contentType := meta.ContentType
	c.mu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", false
	}
	return data, contentType, true
}

func (c *Cache) Put(key, contentType string, data []byte, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabled {
		return
	}
	if old, ok := c.entries[key]; ok {
		c.bytes -= old.Size
	}
	size := int64(len(data))
	if size > c.max {
		return
	}
	if err := os.WriteFile(filepath.Join(c.dir, key+".bin"), data, 0o644); err != nil {
		return
	}
	now := time.Now().Unix()
	c.entries[key] = Meta{
		Key:         key,
		ContentType: contentType,
		Size:        size,
		Expires:     time.Now().Add(ttl).Unix(),
		Used:        now,
	}
	c.bytes += size
	c.evictLocked()
	c.saveLocked()
}

func (c *Cache) evictLocked() {
	if c.bytes <= c.max {
		return
	}
	type pair struct {
		key  string
		meta Meta
	}
	items := make([]pair, 0, len(c.entries))
	for key, meta := range c.entries {
		items = append(items, pair{key, meta})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].meta.Used < items[j].meta.Used })
	for _, item := range items {
		if c.bytes <= c.max {
			break
		}
		c.removeLocked(item.key, item.meta)
	}
}

func (c *Cache) removeLocked(key string, meta Meta) {
	delete(c.entries, key)
	c.bytes -= meta.Size
	os.Remove(filepath.Join(c.dir, key+".bin"))
}

func (c *Cache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{
		Enabled: c.enabled,
		Entries: len(c.entries),
		Bytes:   c.bytes,
		MaxMB:   c.max / (1024 * 1024),
	}
}

// PurgeURL drops every cached entry that belongs to one upstream URL, so a
// single episode can be refreshed without wiping everything else.
func (c *Cache) PurgeURL(target string) int64 {
	if target == "" {
		return 0
	}
	prefix := Key("relay", target, "1")
	prefix = prefix[:len(prefix)-4]

	c.mu.Lock()
	defer c.mu.Unlock()
	var freed int64
	for key, meta := range c.entries {
		if strings.HasPrefix(key, prefix) {
			freed += meta.Size
			c.removeLocked(key, meta)
		}
	}
	if freed > 0 {
		c.saveLocked()
	}
	return freed
}

func (c *Cache) Clear() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	freed := c.bytes
	for key, meta := range c.entries {
		c.removeLocked(key, meta)
	}
	c.bytes = 0
	c.saveLocked()
	return freed
}
