// The run log, with the size-based rotation of src/log-rotation.ts and RunLogger in src/logger.ts (see runlog.go).
//
//   - segment 1 is the plain run file (spec.logPath), segment n >= 2 is logPath + "." + n;
//   - a line goes whole into one segment: it starts the next segment when it would take a non-empty segment over the
//     limit, and a line longer than the limit sits alone in its segment, unsplit;
//   - before each line the writer moves on to the next segment if another writer already made it, and the size it
//     compares is the file's, not its own count;
//   - the writer that creates a segment deletes the segments before the last KeepSegments and, when it did, opens the
//     new segment with one marker line saying how many earlier segments are gone.

use crate::ansi::strip_ansi;
use crate::timefmt::log_stamp;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// spec.logRotation: the limits of one run, resolved by the daemon.
#[derive(Clone, Copy, Debug, Default)]
pub struct LogRotation {
    /// Closes a segment when the next line would take it over this size. 0 means no rotation.
    pub max_bytes: i64,
    /// How many segments of the run are kept, the newest ones. At least 1 when max_bytes is set.
    pub keep_segments: i64,
}

const BYTES_PER_MB: i64 = 1_048_576;

/// Segment n of the run whose first segment is `first`: segment 1 is `first` itself.
pub fn segment_path(first: &Path, n: usize) -> PathBuf {
    if n <= 1 {
        return first.to_path_buf();
    }
    let mut s: OsString = first.as_os_str().to_owned();
    s.push(format!(".{n}"));
    PathBuf::from(s)
}

/// The segment number of file name `name` for the run file `base` (a base name), or 0 when it is not one.
fn segment_number(base: &str, name: &str) -> usize {
    if name == base {
        return 1;
    }
    let Some(suffix) = name.strip_prefix(base).and_then(|r| r.strip_prefix('.')) else { return 0 };
    if suffix.is_empty() {
        return 0;
    }
    match suffix.parse::<i64>() {
        Ok(n) if n >= 2 && n.to_string() == suffix => n as usize,
        _ => 0,
    }
}

/// The segment numbers of the run that exist in its folder.
fn segments_of(first: &Path) -> Vec<usize> {
    let dir = match first.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let Some(base) = first.file_name().and_then(|b| b.to_str()) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if let Some(name) = e.file_name().to_str() {
            let n = segment_number(base, name);
            if n > 0 {
                out.push(n);
            }
        }
    }
    out
}

fn format_limit(max_bytes: i64) -> String {
    if max_bytes % BYTES_PER_MB == 0 {
        format!("{} MB", max_bytes / BYTES_PER_MB)
    } else {
        format!("{max_bytes} bytes")
    }
}

/// dropMarkerText of src/log-rotation.ts, word for word.
pub fn drop_marker_text(dropped: i64, keep: i64, max_bytes: i64) -> String {
    let plural = |n: i64, one: &'static str, many: &'static str| if n == 1 { one } else { many };
    format!(
        "[orch] log rotation: {dropped} earlier segment{} of this run {} dropped (only the last {keep} segment{} kept, each at most {}; see logRotation in docs/daemon-config.md)",
        plural(dropped, "", "s"),
        plural(dropped, "was", "were"),
        plural(keep, " is", "s are"),
        format_limit(max_bytes)
    )
}

fn append_options() -> OpenOptions {
    let mut o = OpenOptions::new();
    o.append(true);
    // Go opens files with FILE_SHARE_READ|FILE_SHARE_WRITE (no FILE_SHARE_DELETE): a segment a reader holds cannot be deleted.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(3);
    }
    o
}

/// Go's error text for a failed open: "open <path>: <os message>" (the os message without Rust's " (os error N)").
pub fn os_msg(e: &io::Error) -> String {
    let s = e.to_string();
    let msg = match s.rfind(" (os error ") {
        Some(i) if s.ends_with(')') => s[..i].to_string(),
        _ => s,
    };
    // Go's syscall error tables on Linux and macOS are the system's messages with a lower-case first letter ("no such
    // file or directory"); Rust prints strerror as is ("No such file or directory"). Seen for ENOENT in the CI
    // differential on both OSes; other errnos are assumed to follow the same rule (not checked one by one). Windows
    // messages are the same text in both languages.
    #[cfg(unix)]
    {
        lower_first(&msg)
    }
    #[cfg(not(unix))]
    {
        msg
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod lower_first_tests {
    use super::lower_first;

    #[test]
    fn lowers_only_the_first_letter() {
        assert_eq!(lower_first("No such file or directory"), "no such file or directory");
        assert_eq!(lower_first("Input/output error"), "input/output error");
        assert_eq!(lower_first("already lower"), "already lower");
        assert_eq!(lower_first(""), "");
    }
}

pub struct RunLog {
    first: PathBuf,
    rot: LogRotation,
    pub now: fn() -> Duration,
    file: Option<File>,
    seg: usize,
    /// Bytes at the start of the current segment that are this writer's own drop marker, not run content.
    marker_bytes: u64,
    reported: bool,
}

impl RunLog {
    /// Opens the newest segment the run already has (segment 1 for a new run) for appending.
    pub fn open(first: &Path, rot: LogRotation, now: fn() -> Duration) -> Result<RunLog, String> {
        let seg = segments_of(first).into_iter().max().unwrap_or(1).max(1);
        let path = segment_path(first, seg);
        let file = append_options()
            .create(true)
            .open(&path)
            .map_err(|e| format!("open {}: {}", path.display(), os_msg(&e)))?;
        Ok(RunLog { first: first.to_path_buf(), rot, now, file: Some(file), seg, marker_bytes: 0, reported: false })
    }

    // Only the rotation tests close a log; the supervisor itself ends the process when the run ends.
    #[cfg(test)]
    pub fn close(&mut self) {
        self.file = None;
    }

    /// The line as it goes into the log, or None when it writes nothing: stripped of escape sequences before the trim, so
    /// a line that was only an erase code is dropped like a blank one.
    pub fn entry_of(now: fn() -> Duration, prefix: &str, line: &[u8]) -> Option<(String, Vec<u8>)> {
        let stripped = strip_ansi(line);
        let end = stripped.iter().rposition(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n')).map_or(0, |i| i + 1);
        if end == 0 {
            return None;
        }
        let ts = log_stamp(now());
        let mut entry = Vec::with_capacity(end + prefix.len() + ts.len() + 4);
        entry.push(b'[');
        entry.extend_from_slice(ts.as_bytes());
        entry.extend_from_slice(b"] ");
        entry.extend_from_slice(prefix.as_bytes());
        entry.extend_from_slice(&stripped[..end]);
        entry.push(b'\n');
        Some((ts, entry))
    }

    // Only the rotation tests call write directly; the supervisor writes through copy_lines (entry_of, then write_entry).
    #[cfg(test)]
    pub fn write(&mut self, prefix: &str, line: &[u8]) {
        if let Some((ts, entry)) = Self::entry_of(self.now, prefix, line) {
            self.write_entry(&ts, &entry);
        }
    }

    fn write_entry(&mut self, ts: &str, entry: &[u8]) {
        if self.file.is_none() {
            return;
        }
        if self.rot.max_bytes > 0 {
            self.make_room_for(entry.len() as i64, ts);
        }
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(entry);
        }
    }

    /// Moves to the segment where `length` more bytes belong: the next one another writer already made, or a new one.
    fn make_room_for(&mut self, length: i64, ts: &str) {
        while fs::metadata(segment_path(&self.first, self.seg + 1)).is_ok() {
            if !self.switch_to(self.seg + 1, false, ts) {
                return;
            }
        }
        let Some(Ok(meta)) = self.file.as_ref().map(|f| f.metadata()) else { return };
        let size = meta.len();
        if size > self.marker_bytes && size as i64 + length > self.rot.max_bytes {
            self.switch_to(self.seg + 1, true, ts);
        }
    }

    /// Makes segment n the current one; false (reported once, nothing changes) when it cannot be opened.
    fn switch_to(&mut self, n: usize, may_create: bool, ts: &str) -> bool {
        let path = segment_path(&self.first, n);
        let mut created = false;
        let mut result: Result<File, String> = if may_create {
            match append_options().create_new(true).open(&path) {
                Ok(f) => {
                    created = true;
                    Ok(f)
                }
                // The other writer made it between our look and now: follow it.
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => append_options().open(&path).map_err(|e| os_msg(&e)),
                Err(e) => Err(os_msg(&e)),
            }
        } else {
            append_options().open(&path).map_err(|e| os_msg(&e))
        };
        if let Ok(f) = &result {
            match f.metadata() {
                Ok(m) if m.is_file() => {}
                _ => result = Err("it exists and is not a regular file".to_string()),
            }
        }
        let next = match result {
            Ok(f) => f,
            Err(msg) => {
                if !self.reported {
                    self.reported = true;
                    eprintln!("orchestrator-supervisor: cannot start the next log segment {}: {msg}. The run keeps writing to the current segment, which can grow past the limit. Check the disk space and the permissions of the log folder.", path.display());
                }
                return false;
            }
        };
        self.file = Some(next);
        self.seg = n;
        self.marker_bytes = 0;
        if created {
            let dropped = n as i64 - self.rot.keep_segments;
            if dropped >= 1 {
                self.drop_segments_up_to(dropped as usize);
                let marker = format!("[{ts}] {}\n", drop_marker_text(dropped, self.rot.keep_segments, self.rot.max_bytes));
                if let Some(f) = self.file.as_mut() {
                    let _ = f.write_all(marker.as_bytes());
                }
                self.marker_bytes = marker.len() as u64;
            }
        }
        true
    }

    /// Deletes the segments of this run numbered up to `last`. One that cannot go (a reader holds it on Windows) goes at
    /// the next rotation.
    fn drop_segments_up_to(&self, last: usize) {
        for n in segments_of(&self.first) {
            if n <= last {
                let _ = fs::remove_file(segment_path(&self.first, n));
            }
        }
    }
}

/// Reads `r` to its end, line by line, keeping a last line that has no newline. Each line is written with one lock.
pub fn copy_lines(log: &Mutex<RunLog>, r: impl Read, prefix: &str) {
    let now = log.lock().unwrap_or_else(|e| e.into_inner()).now;
    let mut reader = BufReader::new(r);
    let mut line = Vec::new();
    loop {
        line.clear();
        let got = reader.read_until(b'\n', &mut line);
        if let Some((ts, entry)) = RunLog::entry_of(now, prefix, &line) {
            log.lock().unwrap_or_else(|e| e.into_inner()).write_entry(&ts, &entry);
        }
        // Go stops at the first read error or EOF, after writing what was read.
        if !matches!(got, Ok(n) if n > 0) {
            return;
        }
    }
}
