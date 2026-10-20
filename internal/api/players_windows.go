//go:build windows

package api

import (
	"os"

	"golang.org/x/sys/windows/registry"
)

// appPath looks an executable up in the registry's App Paths hive without
// spawning a shell (a subprocess per lookup used to flash console windows).
func appPath(exe string) string {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		key, err := registry.OpenKey(
			root,
			`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`+exe,
			registry.QUERY_VALUE,
		)
		if err != nil {
			continue
		}
		value, _, err := key.GetStringValue("")
		key.Close()
		if err != nil {
			continue
		}
		// Stored values are often quoted.
		value = trimQuotes(value)
		if info, err := os.Stat(value); err == nil && !info.IsDir() {
			return value
		}
	}
	return ""
}

func trimQuotes(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return value[1 : len(value)-1]
	}
	return value
}
