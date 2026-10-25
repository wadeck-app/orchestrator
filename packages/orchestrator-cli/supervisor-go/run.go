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
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	Killed     bool   `json:"killed,omitempty"`
	KillReason string `json:"killReason,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Error      string `json:"error,omitempty"`
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
	// A rename can fail for a moment on Windows while a reader or a virus scanner holds the target: the final
	// status carries the exit code, so it is worth a few tries before giving up.
	var renameErr error
	for attempt := 1; attempt <= 6; attempt++ {
		if renameErr = os.Rename(tmp, filepath.Join(runDir, "status.json")); renameErr == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt) * 25 * time.Millisecond)
	}
	return renameErr
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

// touch records one more beat: the counter is the evidence, the modification time is only a convenience.
func touch(path string, beat int) {
	now := time.Now()
	if err := os.WriteFile(path, []byte(strconv.Itoa(beat)), 0o644); err == nil {
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
	// The supervisor, not the daemon, reads the job's output, so it keeps flowing while the daemon is away.
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return failToStart(fmt.Sprintf("cannot read the job's stdout: %v", err))
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return failToStart(fmt.Sprintf("cannot read the job's stderr: %v", err))
	}
	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		return failToStart(fmt.Sprintf("cannot start %q (cwd %q): %v", spec.Command, spec.Cwd, err))
	}
	log := &runLog{file: logFile}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); log.copyLines(stdout, "") }()
	go func() { defer readers.Done(); log.copyLines(stderr, "[stderr] ") }()

	running := base
	running.State = "running"
	running.ChildPid = cmd.Process.Pid
	running.StartedAt = stamp(startedAt)
	if err := writeStatus(runDir, running); err != nil {
		// Without a status file nobody can adopt this run: end the job rather than leave one nobody can see.
		endTree(cmd.Process.Pid, spec)
		readers.Wait()
		_ = cmd.Wait()
		return failToStart(fmt.Sprintf("cannot write status.json in %s: %v", runDir, err))
	}

	waited := make(chan struct{})
	go func() {
		// Wait must not run before every read of the pipes is done. It also means the run ends when the job's
		// output closes, as node's "close" event did: a background process that kept the pipe open keeps the run open.
		readers.Wait()
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
	beats := 1
	touch(filepath.Join(runDir, "heartbeat"), beats)

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
			beats++
			touch(filepath.Join(runDir, "heartbeat"), beats)
		case <-pollTick.C:
			if !final.Killed && fileExists(filepath.Join(runDir, "kill")) {
				final.Killed = true
				final.KillReason = killReason(filepath.Join(runDir, "kill"))
				go endTree(running.ChildPid, spec)
			} else if !final.TimedOut && !deadline.IsZero() && time.Now().After(deadline) {
				final.TimedOut = true
				go endTree(running.ChildPid, spec)
			}
		}
	}

	// The daemon ends the tree itself as well as writing `kill`, so the job can be gone before the poll above
	// ever saw the file. A kill asked for while it was ending is still a kill, and the reason must survive.
	if !final.Killed && fileExists(filepath.Join(runDir, "kill")) {
		final.Killed = true
		final.KillReason = killReason(filepath.Join(runDir, "kill"))
	}
	final.State = "exited"
	final.FinishedAt = stamp(time.Now())
	final.ExitCode, final.Signal = exitOf(cmd.ProcessState)
	// The one write that must not be lost: it carries the exit code, and without it the run reads "running" for ever.
	// A reader or a virus scanner can hold the file for a moment on Windows, so keep trying for a good while.
	var writeErr error
	for attempt := 0; attempt < 60; attempt++ {
		if writeErr = writeStatus(runDir, final); writeErr == nil {
			return 0
		}
		time.Sleep(250 * time.Millisecond)
	}
	fmt.Fprintln(os.Stderr, "orchestrator-supervisor: cannot write the final status.json:", writeErr)
	return 1
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

// killReason is the content of the kill file: why the daemon asked ("manual", "resource-limit").
//
// The file is seen to exist before it is read, and a read can fail or find nothing for a moment even though the daemon
// writes it whole (a scanner or indexer holding a new file on Windows; an older daemon writing it in place). That used
// to be recorded as "unspecified", the run then reading as killed for no reason. It is read again for about two seconds
// first, and when it never becomes readable the record says why instead of a bare "unspecified".
func killReason(path string) string {
	var lastErr error
	for attempt := 0; attempt < killReadAttempts; attempt++ {
		if attempt > 0 {
			killReadPause()
		}
		data, err := os.ReadFile(path)
		lastErr = err
		if err == nil && strings.TrimSpace(string(data)) != "" {
			return strings.TrimSpace(string(data))
		}
	}
	if lastErr != nil {
		return "unspecified (kill file unreadable: " + lastErr.Error() + ")"
	}
	return "unspecified"
}

const killReadAttempts = 100

// killReadPause is the wait between two reads of the kill file; a test replaces it.
var killReadPause = func() { time.Sleep(20 * time.Millisecond) }

// runLog writes the run log in the exact format the daemon's RunLogger used: "[YYYY-MM-DD HH:MM:SS] text" in
// UTC, trailing whitespace trimmed, blank lines dropped, stderr lines prefixed. One write per line, appended,
// so the daemon can add its own markers to the same file without tearing a line.
type runLog struct {
	mu   sync.Mutex
	file *os.File
}

func (l *runLog) write(prefix string, line string) {
	// Escape sequences are stripped before the trim, so a line that was only an erase code is dropped like a blank one.
	text := strings.TrimRight(stripAnsi(line), " \t\r\n")
	if text == "" {
		return
	}
	entry := "[" + time.Now().UTC().Format("2006-01-02 15:04:05") + "] " + prefix + text + "\n"
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.file.WriteString(entry)
}

// copyLines reads r to its end, line by line, keeping a last line that has no newline.
func (l *runLog) copyLines(r io.Reader, prefix string) {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadString('\n')
		l.write(prefix, line)
		if err != nil {
			return
		}
	}
}
