package main

// Size-based rotation of the run log, the supervisor's half. The rules are the ones of RunLogger in src/logger.ts
// (the daemon writes to the same run), and test/run-log-rotation.test.js pins the same cases there: a line goes whole
// into one segment, a segment holds up to the limit exactly, a line longer than the limit sits alone, the oldest segments
// beyond keepSegments are deleted and the segment that follows opens with one marker line.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

var fixedNow = func() time.Time { return time.Date(2026, 10, 25, 10, 0, 5, 0, time.UTC) }

func entryOf(text string) string { return "[2026-10-25 10:00:05] " + text + "\n" }

func rotatingLog(t *testing.T, dir string, maxBytes int64, keep int) (*runLog, string) {
	t.Helper()
	first := filepath.Join(dir, "job-2026-10-25T10-00-00.log")
	l, err := openRunLog(first, LogRotation{MaxBytes: maxBytes, KeepSegments: keep}, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.close)
	return l, first
}

func fileNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func sameNames(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("files: want %v, got %v", want, got)
	}
}

func TestSegmentPath(t *testing.T) {
	if got := segmentPath("/l/job-x.log", 1); got != "/l/job-x.log" {
		t.Fatalf("segment 1 is the plain file, got %q", got)
	}
	if got := segmentPath("/l/job-x.log", 12); got != "/l/job-x.log.12" {
		t.Fatalf("segment 12, got %q", got)
	}
}

func TestWithoutLimitsTheRunLogStaysOneFile(t *testing.T) {
	dir := t.TempDir()
	l, _ := rotatingLog(t, dir, 0, 3)
	for i := 0; i < 200; i++ {
		l.write("", fmt.Sprintf("line %d", i))
	}
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log")
}

func TestASegmentHoldsExactlyTheLimitAndTheNextLineStartsTheNext(t *testing.T) {
	dir := t.TempDir()
	each := int64(len(entryOf("aaaa")))
	l, first := rotatingLog(t, dir, each*3, 10)
	for _, s := range []string{"aaaa", "bbbb", "cccc", "dddd"} {
		l.write("", s)
	}
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log", "job-2026-10-25T10-00-00.log.2")
	if got := readText(t, first); got != entryOf("aaaa")+entryOf("bbbb")+entryOf("cccc") {
		t.Fatalf("segment 1: %q", got)
	}
	if got := readText(t, first+".2"); got != entryOf("dddd") {
		t.Fatalf("segment 2: %q", got)
	}
}

func TestOneByteLessRoomRotatesOneLineEarlier(t *testing.T) {
	dir := t.TempDir()
	each := int64(len(entryOf("aaaa")))
	l, first := rotatingLog(t, dir, each*3-1, 10)
	for _, s := range []string{"aaaa", "bbbb", "cccc"} {
		l.write("", s)
	}
	if got := readText(t, first); got != entryOf("aaaa")+entryOf("bbbb") {
		t.Fatalf("segment 1: %q", got)
	}
	if got := readText(t, first+".2"); got != entryOf("cccc") {
		t.Fatalf("segment 2: %q", got)
	}
}

func TestALineLongerThanTheLimitSitsAloneAndUnsplit(t *testing.T) {
	dir := t.TempDir()
	l, first := rotatingLog(t, dir, 40, 10)
	huge := strings.Repeat("x", 500)
	l.write("", "a")
	l.write("", huge)
	l.write("", "b")
	if got := readText(t, first); got != entryOf("a") {
		t.Fatalf("segment 1: %q", got)
	}
	if got := readText(t, first+".2"); got != entryOf(huge) {
		t.Fatalf("segment 2: %q", got)
	}
	if got := readText(t, first+".3"); got != entryOf("b") {
		t.Fatalf("segment 3: %q", got)
	}
}

func TestALongFirstLineIsNotPrecededByAnEmptySegment(t *testing.T) {
	dir := t.TempDir()
	l, _ := rotatingLog(t, dir, 40, 10)
	l.write("", strings.Repeat("y", 300))
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log")
}

func TestNoLineIsLostOrSplitAcrossManySegments(t *testing.T) {
	dir := t.TempDir()
	l, first := rotatingLog(t, dir, 100, 1000)
	var want strings.Builder
	for i := 0; i < 120; i++ {
		text := fmt.Sprintf("n%d:%s", i, strings.Repeat("z", i%37))
		want.WriteString(entryOf(text))
		l.write("", text)
	}
	names := fileNames(t, dir)
	if len(names) < 10 {
		t.Fatalf("expected many segments, got %d", len(names))
	}
	var got strings.Builder
	got.WriteString(readText(t, first))
	for n := 2; n <= len(names); n++ {
		got.WriteString(readText(t, segmentPath(first, n)))
	}
	if got.String() != want.String() {
		t.Fatal("the segments read back in order are not what was written")
	}
}

func oneLinePerSegment(t *testing.T, dir string, count, keep int) string {
	t.Helper()
	l, first := rotatingLog(t, dir, int64(len(entryOf("l000"))), keep)
	for i := 1; i <= count; i++ {
		l.write("", fmt.Sprintf("l%03d", i))
	}
	return first
}

func TestOnlyTheLastKeepSegmentsStay(t *testing.T) {
	dir := t.TempDir()
	oneLinePerSegment(t, dir, 8, 3)
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log.6", "job-2026-10-25T10-00-00.log.7", "job-2026-10-25T10-00-00.log.8")
}

func TestNothingIsDroppedWhileThereAreFewerSegmentsThanKept(t *testing.T) {
	dir := t.TempDir()
	first := oneLinePerSegment(t, dir, 3, 5)
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log", "job-2026-10-25T10-00-00.log.2", "job-2026-10-25T10-00-00.log.3")
	for n := 1; n <= 3; n++ {
		if strings.Contains(readText(t, segmentPath(first, n)), "log rotation") {
			t.Fatalf("segment %d carries a drop marker although nothing was dropped", n)
		}
	}
}

var markerRe = regexp.MustCompile(`^\[2026-10-25 10:00:05\] \[orch\] log rotation: (\d+) earlier segments? of this run (?:was|were) dropped \(only the last (\d+) segments? (?:is|are) kept, each at most (\d+) bytes; see logRotation in docs/daemon-config\.md\)$`)

func TestTheSegmentAfterADropOpensWithOneMarkerLine(t *testing.T) {
	dir := t.TempDir()
	first := oneLinePerSegment(t, dir, 8, 3)
	line := strings.SplitN(readText(t, first+".6"), "\n", 2)[0]
	m := markerRe.FindStringSubmatch(line)
	if m == nil || m[1] != "3" || m[2] != "3" {
		t.Fatalf("segment 6 should open with the marker for 3 dropped segments, got %q", line)
	}
	last := readText(t, first+".8")
	if !strings.HasPrefix(last, "[2026-10-25 10:00:05] [orch] log rotation: 5 earlier segments of this run were dropped") {
		t.Fatalf("segment 8: %q", last)
	}
	if !strings.Contains(last, "l008") {
		t.Fatalf("the run's own line must follow the marker: %q", last)
	}
}

// The same words as dropMarkerText in src/log-rotation.ts, singular and plural included.
func TestTheMarkerWordsMatchTheDaemonsForOneSegment(t *testing.T) {
	dir := t.TempDir()
	first := oneLinePerSegment(t, dir, 3, 1)
	want := "[2026-10-25 10:00:05] [orch] log rotation: 2 earlier segments of this run were dropped (only the last 1 segment is kept, each at most 27 bytes; see logRotation in docs/daemon-config.md)\n"
	if got := readText(t, first+".3"); !strings.HasPrefix(got, want) {
		t.Fatalf("want a segment starting with %q, got %q", want, got)
	}
	dir2 := t.TempDir()
	first2 := oneLinePerSegment(t, dir2, 2, 1)
	want2 := "[2026-10-25 10:00:05] [orch] log rotation: 1 earlier segment of this run was dropped (only the last 1 segment is kept, each at most 27 bytes; see logRotation in docs/daemon-config.md)\n"
	if got := readText(t, first2+".2"); !strings.HasPrefix(got, want2) {
		t.Fatalf("want a segment starting with %q, got %q", want2, got)
	}
}

func TestAMarkerAloneDoesNotFillASegment(t *testing.T) {
	dir := t.TempDir()
	l, first := rotatingLog(t, dir, 40, 1)
	l.write("", "first")
	l.write("", strings.Repeat("x", 300))
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log.2")
	lines := strings.Split(strings.TrimSuffix(readText(t, first+".2"), "\n"), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "log rotation: 1 earlier segment") || !strings.HasSuffix(lines[1], strings.Repeat("x", 300)) {
		t.Fatalf("want the marker then the long line, got %q", lines)
	}
}

// A writer opened on a run that already has segments (the supervisor never restarts, but the daemon's RunLogger and a
// second supervisor start of the same run both rely on this) appends to the newest one.
func TestOpeningARunThatAlreadyHasSegmentsAppendsToTheNewest(t *testing.T) {
	dir := t.TempDir()
	each := int64(len(entryOf("aaaa")))
	l, first := rotatingLog(t, dir, each*2, 100)
	for _, s := range []string{"aaaa", "bbbb", "cccc"} {
		l.write("", s)
	}
	l.close()
	l2, _ := rotatingLog(t, dir, each*2, 100)
	l2.write("", "dddd")
	l2.write("", "eeee")
	if got := readText(t, first+".2"); got != entryOf("cccc")+entryOf("dddd") {
		t.Fatalf("segment 2: %q", got)
	}
	if got := readText(t, first+".3"); got != entryOf("eeee") {
		t.Fatalf("segment 3: %q", got)
	}
}

// The daemon writes its markers into the same run: a writer that is behind moves on to the segment the other made.
func TestAWriterBehindFollowsTheOneThatMovedOn(t *testing.T) {
	dir := t.TempDir()
	each := int64(len(entryOf("aaaa")))
	ahead, first := rotatingLog(t, dir, each*2, 100)
	behind, _ := rotatingLog(t, dir, each*2, 100)
	ahead.write("", "aaaa")
	ahead.write("", "bbbb")
	ahead.write("", "cccc")
	behind.write("", "late")
	if got := readText(t, first); got != entryOf("aaaa")+entryOf("bbbb") {
		t.Fatalf("segment 1: %q", got)
	}
	if got := readText(t, first+".2"); got != entryOf("cccc")+entryOf("late") {
		t.Fatalf("segment 2: %q", got)
	}
}

func TestTwoWritersInterleavingLoseNothing(t *testing.T) {
	dir := t.TempDir()
	a, first := rotatingLog(t, dir, 120, 1000)
	b, _ := rotatingLog(t, dir, 120, 1000)
	var wantA, wantB []string
	for i := 0; i < 60; i++ {
		ta := fmt.Sprintf("daemon %d", i)
		tb := fmt.Sprintf("output %d:%s", i, strings.Repeat("q", i%11))
		a.write("", ta)
		b.write("", tb)
		wantA = append(wantA, ta)
		wantB = append(wantB, tb)
	}
	names := fileNames(t, dir)
	var all strings.Builder
	all.WriteString(readText(t, first))
	for n := 2; n <= len(names); n++ {
		all.WriteString(readText(t, segmentPath(first, n)))
	}
	var gotA, gotB []string
	for _, line := range strings.Split(strings.TrimSuffix(all.String(), "\n"), "\n") {
		text := strings.TrimPrefix(line, "[2026-10-25 10:00:05] ")
		if strings.HasPrefix(text, "daemon") {
			gotA = append(gotA, text)
		} else if strings.HasPrefix(text, "output") {
			gotB = append(gotB, text)
		} else {
			t.Fatalf("a torn or foreign line: %q", line)
		}
	}
	if strings.Join(gotA, "|") != strings.Join(wantA, "|") || strings.Join(gotB, "|") != strings.Join(wantB, "|") {
		t.Fatal("a line was lost, duplicated or reordered")
	}
}

func TestACompletelyBlankOrAnsiOnlyLineWritesNothingAndNeverRotates(t *testing.T) {
	dir := t.TempDir()
	l, _ := rotatingLog(t, dir, 40, 3)
	l.write("", "   ")
	l.write("", "\x1b[2K")
	sameNames(t, fileNames(t, dir), "job-2026-10-25T10-00-00.log")
}

// The whole supervisor, with a real job printing more than the limit: the spec is where the limits come from.
func TestRunRotatesTheLogOfARealJobFromTheSpec(t *testing.T) {
	dir := t.TempDir()
	cmd := jsCommand(t, dir, `for (let i = 0; i < 40; i++) console.log("row " + String(i).padStart(3, "0") + " " + "p".repeat(20)); process.exit(0)`)
	runDir, done := startRun(t, Spec{Command: cmd, LogRotation: &LogRotation{MaxBytes: 300, KeepSegments: 1000}})
	finish(t, done)

	logDir := runDir
	names := fileNames(t, logDir)
	var segs []string
	for _, n := range names {
		if strings.HasPrefix(n, "run.log") {
			segs = append(segs, n)
		}
	}
	if len(segs) < 3 {
		t.Fatalf("expected the output to span several segments, got %v", segs)
	}
	var all strings.Builder
	all.WriteString(readText(t, filepath.Join(logDir, "run.log")))
	for n := 2; n <= len(segs); n++ {
		all.WriteString(readText(t, filepath.Join(logDir, fmt.Sprintf("run.log.%d", n))))
	}
	for i := 0; i < 40; i++ {
		if !strings.Contains(all.String(), fmt.Sprintf("row %03d ", i)) {
			t.Fatalf("row %d is missing from the segments", i)
		}
	}
	for _, n := range segs {
		info, _ := os.Stat(filepath.Join(logDir, n))
		if info.Size() > 300 {
			t.Fatalf("%s is %d bytes, over the 300 limit although no line is that long", n, info.Size())
		}
	}
}

func TestRunWithoutLimitsInTheSpecWritesOneFile(t *testing.T) {
	dir := t.TempDir()
	cmd := jsCommand(t, dir, `for (let i = 0; i < 40; i++) console.log("row " + i + " " + "p".repeat(40)); process.exit(0)`)
	runDir, done := startRun(t, Spec{Command: cmd})
	finish(t, done)
	for _, n := range fileNames(t, runDir) {
		if strings.HasPrefix(n, "run.log.") {
			t.Fatalf("no limit was given, yet %s exists", n)
		}
	}
}

func TestASpecWithANegativeLimitIsRefused(t *testing.T) {
	dir := t.TempDir()
	runDir, done := startRun(t, Spec{Command: jsCommand(t, dir, `0`), LogRotation: &LogRotation{MaxBytes: -5, KeepSegments: 3}})
	if code := finish(t, done); code == 0 {
		t.Fatal("a negative maxBytes must not start the job")
	}
	st := readStatus(t, runDir)
	if st.State != "failed-to-start" || !strings.Contains(st.Error, "logRotation") {
		t.Fatalf("want failed-to-start naming logRotation, got %+v", st)
	}
}
