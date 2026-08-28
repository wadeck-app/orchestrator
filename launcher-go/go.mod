module wadeck.ch/orchestrator/launcher

go 1.25.0

toolchain go1.26.4

require wadeck.ch/singleton-daemon-kit/go-launcher v0.0.0

require golang.org/x/sys v0.47.0 // indirect

replace wadeck.ch/singleton-daemon-kit/go-launcher => ../node_modules/@wadeck-app/singleton-daemon-kit/go-launcher
