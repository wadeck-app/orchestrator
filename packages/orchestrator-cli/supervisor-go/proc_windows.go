//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

const (
	createNoWindow      = 0x08000000
	createNewProcessGrp = 0x00000200
	processQueryLimited = 0x1000
	stillActive         = 259
)

// buildCommand runs the job the way node's `shell: true` did: cmd.exe /d /s /c "<command>". The command line
// is handed over verbatim, because Go's own quoting would escape the quotes cmd.exe expects to see.
func buildCommand(spec Spec) *exec.Cmd {
	cmd := exec.Command("cmd.exe")
	cmd.Dir = spec.Cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /d /s /c "` + spec.Command + `"`,
		HideWindow:    true,
		CreationFlags: createNoWindow | createNewProcessGrp,
	}
	return cmd
}

// endTree ends the job and everything it started. taskkill /T walks the tree itself.
func endTree(pid int, _ Spec) {
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	_ = kill.Run()
}

func exitOf(state *os.ProcessState) (*int, string) {
	if state == nil {
		return nil, ""
	}
	code := state.ExitCode()
	return &code, ""
}

func processAlive(pid int) bool {
	handle, err := syscall.OpenProcess(processQueryLimited, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}
