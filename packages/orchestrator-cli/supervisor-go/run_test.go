package main

// The supervisor owns one job outside the daemon, so that the daemon can restart at any moment.
// These tests pin the file contract the daemon relies on (see run.go): what is written when the job
// ends normally, fails, is killed on request, times out, or never starts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// node is on every machine that runs the daemon, and its quoting works the same under cmd.exe and sh.
func jsCommand(t *testing.T, dir string, source string) string {
	t.Helper()
	script := filepath.Join(dir, "job.js")
	if err := os.WriteFile(script, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	return `node "` + script + `"`
}

func startRun(t *testing.T, spec Spec) (runDir string, done chan int) {
	t.Helper()
	runDir = t.TempDir()
	spec.LogPath = filepath.Join(runDir, "run.log")
	if spec.HeartbeatMs == 0 {
		spec.HeartbeatMs = 50
	}
	writeJSON(t, filepath.Join(runDir, "spec.json"), spec)
	done = make(chan int, 1)
	go func() { done <- Run(runDir) }()
	return runDir, done
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readStatus(t *testing.T, runDir string) Status {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
	if err != nil {
		t.Fatalf("status.json: %v", err)
	}
	var st Status
	if err := json.Unmarshal(data, &st); err != nil {
		t.Fatalf("status.json is not JSON: %v\n%s", err, data)
	}
	return st
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func finish(t *testing.T, done chan int) int {
	t.Helper()
	select {
	case code := <-done:
		return code
	case <-time.After(20 * time.Second):
		t.Fatal("the supervisor did not return")
		return -1
	}
}

func TestRecordsTheExitCodeAndTheOutputOfAFinishedJob(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `console.log("hello"); console.error("oops"); process.exit(3)`)})
	finish(t, done)

	st := readStatus(t, runDir)
	if st.State != "exited" || st.ExitCode == nil || *st.ExitCode != 3 {
		t.Fatalf("want exited with code 3, got %+v", st)
	}
	if st.FinishedAt == "" || st.StartedAt == "" || st.ChildPid == 0 || st.SupervisorPid == 0 {
		t.Fatalf("a finished run must say when it started and ended and who ran it: %+v", st)
	}
	log, _ := os.ReadFile(filepath.Join(runDir, "run.log"))
	if !strings.Contains(string(log), "hello") || !strings.Contains(string(log), "oops") {
		t.Fatalf("stdout and stderr both belong in the run log, got %q", log)
	}
}

func TestReportsARunningJobBeforeItEnds(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setTimeout(() => {}, 3000)`)})

	waitFor(t, "status running", func() bool {
		data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
		return err == nil && strings.Contains(string(data), `"running"`)
	})
	st := readStatus(t, runDir)
	if st.ChildPid == 0 || st.ExitCode != nil || st.FinishedAt != "" {
		t.Fatalf("a running job has a pid and no end yet: %+v", st)
	}
	writeKill(t, runDir)
	finish(t, done)
}

func TestTouchesTheHeartbeatWhileTheJobRuns(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setTimeout(() => {}, 3000)`)})
	beat := filepath.Join(runDir, "heartbeat")

	var first time.Time
	waitFor(t, "first heartbeat", func() bool {
		info, err := os.Stat(beat)
		if err != nil {
			return false
		}
		first = info.ModTime()
		return true
	})
	waitFor(t, "heartbeat to move", func() bool {
		info, err := os.Stat(beat)
		return err == nil && info.ModTime().After(first)
	})
	writeKill(t, runDir)
	finish(t, done)
}

func writeKill(t *testing.T, runDir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(runDir, "kill"), []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAKillRequestEndsTheWholeJobAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setInterval(() => {}, 1000)`)})
	waitFor(t, "the job to run", func() bool {
		data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
		return err == nil && strings.Contains(string(data), `"running"`)
	})
	pid := readStatus(t, runDir).ChildPid

	writeKill(t, runDir)
	finish(t, done)

	st := readStatus(t, runDir)
	if st.State != "exited" || !st.Killed {
		t.Fatalf("a killed job is exited and flagged killed: %+v", st)
	}
	if processAlive(pid) {
		t.Fatalf("the job's process %d survived its kill", pid)
	}
}

func TestATimeoutEndsTheJobWithoutTheDaemon(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setInterval(() => {}, 1000)`), TimeoutSeconds: 1})
	finish(t, done)

	st := readStatus(t, runDir)
	if !st.TimedOut || st.State != "exited" {
		t.Fatalf("want timed out and exited, got %+v", st)
	}
	if processAlive(st.ChildPid) {
		t.Fatalf("the job's process %d survived its timeout", st.ChildPid)
	}
}

func TestAJobThatCannotStartIsReportedNotLost(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `process.exit(0)`), Cwd: filepath.Join(dir, "does-not-exist")})
	code := finish(t, done)

	st := readStatus(t, runDir)
	if st.State != "failed-to-start" || st.Error == "" {
		t.Fatalf("a job that did not start says why: %+v", st)
	}
	if code == 0 {
		t.Fatal("the supervisor must not exit 0 for a job that never started")
	}
}

func TestRefusesASpecItCannotRead(t *testing.T) {
	runDir := t.TempDir()
	if code := Run(runDir); code == 0 {
		t.Fatal("a run folder without spec.json must fail")
	}
	st := readStatus(t, runDir)
	if st.State != "failed-to-start" || !strings.Contains(st.Error, "spec.json") {
		t.Fatalf("the status must name the file that is missing: %+v", st)
	}
}

func TestNeverLeavesAHalfWrittenStatus(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setTimeout(() => {}, 1500)`)})
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
		if err == nil {
			var st Status
			if jsonErr := json.Unmarshal(data, &st); jsonErr != nil {
				t.Fatalf("a reader saw a half-written status.json: %v\n%s", jsonErr, data)
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	writeKill(t, runDir)
	finish(t, done)
}
