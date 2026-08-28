package main

import (
	"os"
	"path/filepath"
	"strings"

	launcher "wadeck.ch/singleton-daemon-kit/go-launcher"
)

func configDirFromArgs(args []string) string {
	for i, arg := range args {
		if arg == "--config" && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, "--config=") {
			return strings.TrimPrefix(arg, "--config=")
		}
	}
	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			return arg
		}
	}
	return launcher.DefaultConfigDir("orchestrator")
}

func main() {
	exe, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	exeDir := filepath.Dir(exe)

	launcher.Run(launcher.Config{
		ConfigDir:  configDirFromArgs(os.Args[1:]),
		NodeScript: filepath.Join(exeDir, "index.js"),
		AppName:    "Orchestrator",
		CLIFlags:   []string{},
		SilentFlags: []string{},
		// UpdateCmd: run by the launcher after the daemon exits when config.update sentinel is present.
		// On Windows, the launcher exits before running this so orchestrator.exe is no longer locked.
		UpdateCmd: []string{"npm", "install", "-g", "@wadeck/orchestrator"},
	})
}
