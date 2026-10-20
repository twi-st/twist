//go:build !windows

package api

import (
	"os/exec"
	"strings"
)

// displayAdapters is only meaningful on Windows; elsewhere the GPU stack is not
// something the app can influence, so it reports nothing.
func displayAdapters() []string {
	if name, err := exec.Command("sh", "-c", "lspci 2>/dev/null | grep -i 'vga\\|3d'").Output(); err == nil {
		var adapters []string
		for _, line := range strings.Split(string(name), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				adapters = append(adapters, line)
			}
		}
		return adapters
	}
	return nil
}
