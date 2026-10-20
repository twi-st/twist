//go:build windows

package api

import (
	"os/exec"
	"strings"
)

// displayAdapters lists the display adapters through PowerShell, which is the
// only dependency-free way to reach WMI here. It is called on demand (settings
// page, diagnostics), never on a hot path.
func displayAdapters() []string {
	output, err := exec.Command(
		"powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
	).Output()
	if err != nil {
		return nil
	}
	var adapters []string
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			adapters = append(adapters, line)
		}
	}
	return adapters
}
