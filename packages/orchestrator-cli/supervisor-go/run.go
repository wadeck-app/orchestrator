package main

// orchestrator-supervisor runs ONE job outside the daemon, so the daemon can be stopped, updated and
// started again at any moment without touching the job.
//
// The whole contract between the daemon and this process is files in the run folder:
//
//	spec.json     written by the daemon before starting us: what to run, where the output goes, the timeout.
//	status.json   written by us, atomically, at every change: who runs the job and how it ended.
//	heartbeat     touched by us every spec.heartbeatMs while the job runs: proof that WE are alive.
//	kill          created by the daemon to ask for the job's whole process tree to be ended.
//
// The daemon never needs a pipe to us, and we never need the daemon: output goes straight to the log
// file, a timeout is enforced here, and the exit code is recorded by us because we are the job's parent.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Spec is spec.json.
type Spec struct {
	// Command is run through the platform shell (cmd.exe /d /s /c, sh -c), as the daemon always did.
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
	// LogPath receives stdout and stderr, appended.
	LogPath string `json:"logPath"`
	// TimeoutSeconds ends the job when it is positive. Zero means no timeout.
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
	// HeartbeatMs defaults to 2000.
	HeartbeatMs int `json:"heartbeatMs,omitempty"`
	// KillGraceMs is how long a polite stop is given before it is forced (unix). Defaults to 300.
	KillGraceMs int `json:"killGraceMs,omitempty"`
}

// Status is status.json. State is "running", "exited" or "failed-to-start".
type Status struct {
	State               string `json:"state"`
	SupervisorPid       int    `json:"supervisorPid"`
	SupervisorStartedAt string `json:"supervisorStartedAt"`
	ChildPid            int    `json:"childPid,omitempty"`
	StartedAt           string `json:"startedAt,omitempty"`
	FinishedAt          string `json:"finishedAt,omitempty"`
	// ExitCode is absent until the job ends, and absent when it ended on a signal.
	ExitCode *int   `json:"exitCode,omitempty"`
	Signal   string `json:"signal,omitempty"`
	// Killed: the daemon asked (kill file). TimedOut: spec.timeoutSeconds elapsed.
	Killed   bool   `json:"killed,omitempty"`
	TimedOut bool   `json:"timedOut,omitempty"`
	Error    string `json:"error,omitempty"`
}

const (
	defaultHeartbeatMs = 2000
	defaultKillGraceMs = 300
	maxControlPollMs   = 250
)

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// writeStatus replaces status.json in one rename, so a reader never sees half of it.
func writeStatus(runDir string, st Status) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	tmp := filepath.Join(runDir, fmt.Sprintf("status.json.%d.tmp", os.Getpid()))
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(runDir, "status.json"))
}

func readSpec(runDir string) (Spec, error) {
	var spec Spec
	data, err := os.ReadFile(filepath.Join(runDir, "spec.json"))
	if err != nil {
		return spec, fmt.Errorf("cannot read spec.json in %s: %w. The daemon writes it before starting the supervisor", runDir, err)
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		return spec, fmt.Errorf("spec.json in %s is not valid JSON: %w", runDir, err)
	}
	if spec.Command == "" || spec.LogPath == "" {
		return spec, fmt.Errorf("spec.json in %s needs a command and a logPath", runDir)
	}
	return spec, nil
}

func touch(path string) {
	now := time.Now()
	if err := os.WriteFile(path, []byte(stamp(now)), 0o644); err == nil {
		_ = os.Chtimes(path, now, now)
	}
}

// Run supervises the job described by <runDir>/spec.json until it ends, and returns the process exit code
// of the supervisor itself: 0 whenever the job was run to its end (whatever the job's own code was, which
// is in status.json), non-zero when the job could not be started.
func Run(runDir string) int {
	base := Status{SupervisorPid: os.Getpid(), SupervisorStartedAt: stamp(time.Now())}

	failToStart := func(message string) int {
		st := base
		st.State = "failed-to-start"
		st.Error = message
		st.FinishedAt = stamp(time.Now())
		_ = writeStatus(runDir, st)
		fmt.Fprintln(os.Stderr, "orchestrator-supervisor:", message)
		return 1
	}

	spec, err := readSpec(runDir)
	if err != nil {
		return failToStart(err.Error())
	}
	logFile, err := os.OpenFile(spec.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return failToStart(fmt.Sprintf("cannot open the run log %s: %v", spec.LogPath, err))
	}
	defer logFile.Close()

	cmd := buildCommand(spec)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		return failToStart(fmt.Sprintf("cannot start %q (cwd %q): %v", spec.Command, spec.Cwd, err))
	}

	running := base
	running.State = "running"
	running.ChildPid = cmd.Process.Pid
	running.StartedAt = stamp(startedAt)
	if err := writeStatus(runDir, running); err != nil {
		// Without a status file nobody can adopt this run: end the job rather than leave one nobody can see.
		endTree(cmd.Process.Pid, spec)
		_ = cmd.Wait()
		return failToStart(fmt.Sprintf("cannot write status.json in %s: %v", runDir, err))
	}

	waited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(waited)
	}()

	heartbeat := time.Duration(orDefault(spec.HeartbeatMs, defaultHeartbeatMs)) * time.Millisecond
	poll := heartbeat
	if poll > maxControlPollMs*time.Millisecond {
		poll = maxControlPollMs * time.Millisecond
	}
	beatTick := time.NewTicker(heartbeat)
	pollTick := time.NewTicker(poll)
	defer beatTick.Stop()
	defer pollTick.Stop()
	touch(filepath.Join(runDir, "heartbeat"))

	var deadline time.Time
	if spec.TimeoutSeconds > 0 {
		deadline = startedAt.Add(time.Duration(spec.TimeoutSeconds) * time.Second)
	}
	final := running
	ended := false
	for !ended {
		select {
		case <-waited:
			ended = true
		case <-beatTick.C:
			touch(filepath.Join(runDir, "heartbeat"))
		case <-pollTick.C:
			if !final.Killed && fileExists(filepath.Join(runDir, "kill")) {
				final.Killed = true
				endTree(running.ChildPid, spec)
			} else if !final.TimedOut && !deadline.IsZero() && time.Now().After(deadline) {
				final.TimedOut = true
				endTree(running.ChildPid, spec)
			}
		}
	}

	final.State = "exited"
	final.FinishedAt = stamp(time.Now())
	final.ExitCode, final.Signal = exitOf(cmd.ProcessState)
	if err := writeStatus(runDir, final); err != nil {
		fmt.Fprintln(os.Stderr, "orchestrator-supervisor: cannot write the final status.json:", err)
		return 1
	}
	return 0
}

func orDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
