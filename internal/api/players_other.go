//go:build !windows

package api

// appPath is only meaningful on Windows; other platforms rely on PATH and the
// known install locations.
func appPath(string) string { return "" }
