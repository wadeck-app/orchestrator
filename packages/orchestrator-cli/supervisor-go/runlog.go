package main

// The run log, with the size-based rotation of src/log-rotation.ts and RunLogger in src/logger.ts. Both write the
// same run (the daemon its markers, this process the job's output), never talk to each other, and so follow the same
// rules over the files:
//
//   - segment 1 is the plain run file (spec.logPath), segment n >= 2 is logPath + "." + n;
//   - a line goes whole into one segment: it starts the next segment when it would take a non-empty segment over the
//     limit, and a line longer than the limit sits alone in its segment, unsplit;
//   - before each line the writer moves on to the next segment if another writer already made it, and the size it
//     compares is the file's, not its own count;
//   - the writer that creates a segment deletes the segments before the last KeepSegments and, when it did, opens the
//     new segment with one marker line saying how many earlier segments are gone.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LogRotation is spec.logRotation: the limits of one run, resolved by the daemon (job setting over config.yml).
type LogRotation struct {
	// MaxBytes closes a segment when the next line would take it over this size. 0 means no rotation.
	MaxBytes int64 `json:"maxBytes"`
	// KeepSegments is how many segments of the run are kept, the newest ones. At least 1 when MaxBytes is set.
	KeepSegments int `json:"keepSegments"`
}

const bytesPerMB = 1048576

// segmentPath is segment n of the run whose first segment is first: segment 1 is first itself.
func segmentPath(first string, n int) string {
	if n <= 1 {
		return first
	}
	return first + "." + strconv.Itoa(n)
}

// segmentNumber is the segment number of file name `name` for the run file `base` (a base name), or 0 when it is not one.
func segmentNumber(base, name string) int {
	if name == base {
		return 1
	}
	suffix, ok := strings.CutPrefix(name, base+".")
	if !ok || suffix == "" {
		return 0
	}
	n, err := strconv.Atoi(suffix)
	if err != nil || n < 2 || strconv.Itoa(n) != suffix {
		return 0
	}
	return n
}

// segmentsOf lists the segment numbers of the run that exist in its folder.
func segmentsOf(first string) []int {
	entries, err := os.ReadDir(filepath.Dir(first))
	if err != nil {
		return nil
	}
	base := filepath.Base(first)
	var out []int
	for _, e := range entries {
		if n := segmentNumber(base, e.Name()); n > 0 {
			out = append(out, n)
		}
	}
	return out
}

func formatLimit(maxBytes int64) string {
	if maxBytes%bytesPerMB == 0 {
		return fmt.Sprintf("%d MB", maxBytes/bytesPerMB)
	}
	return fmt.Sprintf("%d bytes", maxBytes)
}

// dropMarkerText is dropMarkerText of src/log-rotation.ts, word for word.
func dropMarkerText(dropped, keep int, maxBytes int64) string {
	plural := func(n int, one, many string) string {
		if n == 1 {
			return one
		}
		return many
	}
	return fmt.Sprintf("[orch] log rotation: %d earlier segment%s of this run %s dropped (only the last %d segment%s kept, each at most %s; see logRotation in docs/daemon-config.md)",
		dropped, plural(dropped, "", "s"), plural(dropped, "was", "were"), keep, plural(keep, " is", "s are"), formatLimit(maxBytes))
}

// runLog writes the run log in the exact format the daemon's RunLogger used: "[YYYY-MM-DD HH:MM:SS] text" in
// UTC, trailing whitespace trimmed, blank lines dropped, stderr lines prefixed. One write per line, appended,
// so the daemon can add its own markers to the same file without tearing a line.
type runLog struct {
	mu    sync.Mutex
	first string
	rot   LogRotation
	now   func() time.Time
	file  *os.File
	seg   int
	// markerBytes: bytes at the start of the current segment that are this writer's own drop marker, not run content.
	markerBytes int64
	reported    bool
}

// openRunLog opens the newest segment the run already has (segment 1 for a new run) for appending.
func openRunLog(first string, rot LogRotation, now func() time.Time) (*runLog, error) {
	seg := 1
	for _, n := range segmentsOf(first) {
		if n > seg {
			seg = n
		}
	}
	file, err := os.OpenFile(segmentPath(first, seg), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &runLog{first: first, rot: rot, now: now, file: file, seg: seg}, nil
}

func (l *runLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func (l *runLog) write(prefix string, line string) {
	// Escape sequences are stripped before the trim, so a line that was only an erase code is dropped like a blank one.
	text := strings.TrimRight(stripAnsi(line), " \t\r\n")
	if text == "" {
		return
	}
	ts := l.now().UTC().Format("2006-01-02 15:04:05")
	entry := "[" + ts + "] " + prefix + text + "\n"
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return
	}
	if l.rot.MaxBytes > 0 {
		l.makeRoomFor(int64(len(entry)), ts)
	}
	_, _ = l.file.WriteString(entry)
}

// makeRoomFor moves to the segment where length more bytes belong: the next one another writer already made, or a new one.
func (l *runLog) makeRoomFor(length int64, ts string) {
	for {
		info, err := os.Stat(segmentPath(l.first, l.seg+1))
		if err != nil {
			break
		}
		_ = info
		if !l.switchTo(l.seg+1, false, ts) {
			return
		}
	}
	info, err := l.file.Stat()
	if err != nil {
		return
	}
	if info.Size() > l.markerBytes && info.Size()+length > l.rot.MaxBytes {
		l.switchTo(l.seg+1, true, ts)
	}
}

// switchTo makes segment n the current one; false (reported once, nothing changes) when it cannot be opened.
func (l *runLog) switchTo(n int, mayCreate bool, ts string) bool {
	path := segmentPath(l.first, n)
	created := false
	var next *os.File
	var err error
	if mayCreate {
		next, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o644)
		if err == nil {
			created = true
		} else if errors.Is(err, fs.ErrExist) {
			// The other writer made it between our look and now: follow it.
			next, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
		}
	} else {
		next, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	}
	if err == nil {
		if info, statErr := next.Stat(); statErr != nil || !info.Mode().IsRegular() {
			_ = next.Close()
			err = errors.New("it exists and is not a regular file")
		}
	}
	if err != nil {
		if !l.reported {
			l.reported = true
			fmt.Fprintf(os.Stderr, "orchestrator-supervisor: cannot start the next log segment %s: %v. The run keeps writing to the current segment, which can grow past the limit. Check the disk space and the permissions of the log folder.\n", path, err)
		}
		return false
	}
	_ = l.file.Close()
	l.file = next
	l.seg = n
	l.markerBytes = 0
	if created {
		if dropped := n - l.rot.KeepSegments; dropped >= 1 {
			l.dropSegmentsUpTo(dropped)
			marker := "[" + ts + "] " + dropMarkerText(dropped, l.rot.KeepSegments, l.rot.MaxBytes) + "\n"
			_, _ = l.file.WriteString(marker)
			l.markerBytes = int64(len(marker))
		}
	}
	return true
}

// dropSegmentsUpTo deletes the segments of this run numbered up to last. One that cannot go (a reader holds it on
// Windows) goes at the next rotation.
func (l *runLog) dropSegmentsUpTo(last int) {
	for _, n := range segmentsOf(l.first) {
		if n <= last {
			_ = os.Remove(segmentPath(l.first, n))
		}
	}
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
