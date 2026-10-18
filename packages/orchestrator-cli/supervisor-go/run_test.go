package main

// The supervisor owns one job outside the daemon, so that the daemon can restart at any moment.
// These tests pin the file contract the daemon relies on (see run.go): what is written when the job
// ends normally, fails, is killed on request, times out, or never starts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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

// The run log must read exactly as it did when the daemon wrote it, so that nothing downstream (the log
// viewer, the log search, the progress engine) can tell whether the daemon restarted during the run.
func TestWritesTheRunLogInTheFormatTheDaemonUsed(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `console.log("first"); console.log(""); console.log("  padded   "); console.error("oops")`)})
	finish(t, done)

	log, _ := os.ReadFile(filepath.Join(runDir, "run.log"))
	lines := strings.Split(strings.TrimRight(string(log), "\n"), "\n")
	stamp := regexp.MustCompile(`^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] `)
	var texts []string
	for _, line := range lines {
		if !stamp.MatchString(line) {
			t.Fatalf("every line starts with a UTC timestamp, got %q", line)
		}
		texts = append(texts, stamp.ReplaceAllString(line, ""))
	}
	want := []string{"first", "  padded", "[stderr] oops"}
	sort.Strings(texts)
	sort.Strings(want)
	if strings.Join(texts, "|") != strings.Join(want, "|") {
		t.Fatalf("blank lines are dropped, trailing spaces trimmed and stderr prefixed; want %q, got %q", want, texts)
	}
}

func TestKeepsALineThatDoesNotEndWithANewline(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `process.stdout.write("no newline at the end")`)})
	finish(t, done)

	log, _ := os.ReadFile(filepath.Join(runDir, "run.log"))
	if !strings.Contains(string(log), "] no newline at the end") {
		t.Fatalf("the last partial line must not be lost, got %q", log)
	}
}

func TestRecordsWhyTheDaemonAskedForTheKill(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setInterval(() => {}, 1000)`)})
	waitFor(t, "the job to run", func() bool {
		data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
		return err == nil && strings.Contains(string(data), `"running"`)
	})
	if err := os.WriteFile(filepath.Join(runDir, "kill"), []byte("resource-limit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	finish(t, done)

	st := readStatus(t, runDir)
	if !st.Killed || st.KillReason != "resource-limit" {
		t.Fatalf("the reason in the kill file is kept, got %+v", st)
	}
}

// A clock jump (sleep/resume, a manual change) must not be able to make a dead supervisor look alive or a live
// one look dead, so the heartbeat carries a counter and not only a modification time.
func TestHeartbeatCarriesACounterThatKeepsGrowing(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setTimeout(() => {}, 3000)`)})
	read := func() int {
		data, err := os.ReadFile(filepath.Join(runDir, "heartbeat"))
		if err != nil {
			return -1
		}
		n, convErr := strconv.Atoi(strings.TrimSpace(string(data)))
		if convErr != nil {
			return -1
		}
		return n
	}
	var first int
	waitFor(t, "a first heartbeat counter", func() bool {
		first = read()
		return first >= 0
	})
	waitFor(t, "the counter to grow", func() bool { return read() > first })
	writeKill(t, runDir)
	finish(t, done)
}

// The daemon writes `kill` and then ends the tree itself, so on a fast machine the job can be gone before the
// supervisor next looks at the file. The reason must be recorded all the same: it is what tells a kill from a crash.
func TestRecordsTheKillReasonEvenWhenTheJobDiedBeforeTheNextLook(t *testing.T) {
	dir := t.TempDir()
	// A heartbeat this slow makes the supervisor look for `kill` only every 250 ms, and the job ends sooner.
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `setTimeout(() => {}, 100)`), HeartbeatMs: 5000})
	waitFor(t, "the job to run", func() bool {
		data, err := os.ReadFile(filepath.Join(runDir, "status.json"))
		return err == nil && strings.Contains(string(data), `"running"`)
	})
	if err := os.WriteFile(filepath.Join(runDir, "kill"), []byte("manual"), 0o644); err != nil {
		t.Fatal(err)
	}
	finish(t, done)

	st := readStatus(t, runDir)
	if !st.Killed || st.KillReason != "manual" {
		t.Fatalf("a kill requested while the job was ending must still be recorded, got %+v", st)
	}
}
