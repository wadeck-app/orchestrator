//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// buildCommand runs the job the way node's `shell: true` did: sh -c "<command>". The job gets a process
// group of its own, so that ending it can reach everything it started.
func buildCommand(spec Spec) *exec.Cmd {
	cmd := exec.Command("/bin/sh", "-c", spec.Command)
	cmd.Dir = spec.Cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// endTree asks the job's whole group to stop, then forces it once the grace period has passed.
func endTree(pid int, spec Spec) {
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	time.Sleep(time.Duration(orDefault(spec.KillGraceMs, defaultKillGraceMs)) * time.Millisecond)
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

func exitOf(state *os.ProcessState) (*int, string) {
	if state == nil {
		return nil, ""
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return nil, status.Signal().String()
	}
	code := state.ExitCode()
	return &code, ""
}

func processAlive(pid int) bool {
	// Signal 0 checks that the process exists without sending anything. A zombie still answers, so a
	// job that was ended but not yet collected reads as alive for a moment: callers poll.
	return syscall.Kill(pid, 0) == nil
}
