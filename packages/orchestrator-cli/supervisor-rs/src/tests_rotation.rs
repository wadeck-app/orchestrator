// Port of rotation_test.go: size-based rotation of the run log, the supervisor's half. The rules are the ones of
// RunLogger in src/logger.ts (the daemon writes to the same run): a line goes whole into one segment, a segment holds up
// to the limit exactly, a line longer than the limit sits alone, the oldest segments beyond keepSegments are deleted and
// the segment that follows opens with one marker line.

use crate::runlog::{segment_path, LogRotation, RunLog};
use crate::tests_run::{start_run, TempDir, TestSpec};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn fixed_now() -> Duration {
    Duration::from_secs(1_792_922_405) // 2026-10-25 10:00:05 UTC
}

fn entry_of(text: &str) -> String {
    format!("[2026-10-25 10:00:05] {text}\n")
}

fn rotating_log(dir: &Path, max_bytes: i64, keep: i64) -> (RunLog, PathBuf) {
    let first = dir.join("job-2026-10-25T10-00-00.log");
    let l = RunLog::open(&first, LogRotation { max_bytes, keep_segments: keep }, fixed_now).unwrap();
    (l, first)
}

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn same_names(got: Vec<String>, want: &[&str]) {
    assert_eq!(got, want, "files");
}

fn w(l: &mut RunLog, text: &str) {
    l.write("", text.as_bytes());
}

#[test]
fn segment_path_naming() {
    assert_eq!(segment_path(Path::new("/l/job-x.log"), 1), PathBuf::from("/l/job-x.log"));
    assert_eq!(segment_path(Path::new("/l/job-x.log"), 12), PathBuf::from("/l/job-x.log.12"));
}

#[test]
fn without_limits_the_run_log_stays_one_file() {
    let d = TempDir::new();
    let (mut l, _) = rotating_log(d.path(), 0, 3);
    for i in 0..200 {
        w(&mut l, &format!("line {i}"));
    }
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log"]);
}

#[test]
fn a_segment_holds_exactly_the_limit_and_the_next_line_starts_the_next() {
    let d = TempDir::new();
    let each = entry_of("aaaa").len() as i64;
    let (mut l, first) = rotating_log(d.path(), each * 3, 10);
    for s in ["aaaa", "bbbb", "cccc", "dddd"] {
        w(&mut l, s);
    }
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log", "job-2026-10-25T10-00-00.log.2"]);
    assert_eq!(read_text(&first), entry_of("aaaa") + &entry_of("bbbb") + &entry_of("cccc"));
    assert_eq!(read_text(&segment_path(&first, 2)), entry_of("dddd"));
}

#[test]
fn one_byte_less_room_rotates_one_line_earlier() {
    let d = TempDir::new();
    let each = entry_of("aaaa").len() as i64;
    let (mut l, first) = rotating_log(d.path(), each * 3 - 1, 10);
    for s in ["aaaa", "bbbb", "cccc"] {
        w(&mut l, s);
    }
    assert_eq!(read_text(&first), entry_of("aaaa") + &entry_of("bbbb"));
    assert_eq!(read_text(&segment_path(&first, 2)), entry_of("cccc"));
}

#[test]
fn a_line_longer_than_the_limit_sits_alone_and_unsplit() {
    let d = TempDir::new();
    let (mut l, first) = rotating_log(d.path(), 40, 10);
    let huge = "x".repeat(500);
    w(&mut l, "a");
    w(&mut l, &huge);
    w(&mut l, "b");
    assert_eq!(read_text(&first), entry_of("a"));
    assert_eq!(read_text(&segment_path(&first, 2)), entry_of(&huge));
    assert_eq!(read_text(&segment_path(&first, 3)), entry_of("b"));
}

#[test]
fn a_long_first_line_is_not_preceded_by_an_empty_segment() {
    let d = TempDir::new();
    let (mut l, _) = rotating_log(d.path(), 40, 10);
    w(&mut l, &"y".repeat(300));
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log"]);
}

#[test]
fn no_line_is_lost_or_split_across_many_segments() {
    let d = TempDir::new();
    let (mut l, first) = rotating_log(d.path(), 100, 1000);
    let mut want = String::new();
    for i in 0..120 {
        let text = format!("n{i}:{}", "z".repeat(i % 37));
        want.push_str(&entry_of(&text));
        w(&mut l, &text);
    }
    let names = file_names(d.path());
    assert!(names.len() >= 10, "expected many segments, got {}", names.len());
    let mut got = read_text(&first);
    for n in 2..=names.len() {
        got.push_str(&read_text(&segment_path(&first, n)));
    }
    assert!(got == want, "the segments read back in order are not what was written");
}

fn one_line_per_segment(dir: &Path, count: usize, keep: i64) -> PathBuf {
    let (mut l, first) = rotating_log(dir, entry_of("l000").len() as i64, keep);
    for i in 1..=count {
        w(&mut l, &format!("l{i:03}"));
    }
    first
}

#[test]
fn only_the_last_keep_segments_stay() {
    let d = TempDir::new();
    one_line_per_segment(d.path(), 8, 3);
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log.6", "job-2026-10-25T10-00-00.log.7", "job-2026-10-25T10-00-00.log.8"]);
}

#[test]
fn nothing_is_dropped_while_there_are_fewer_segments_than_kept() {
    let d = TempDir::new();
    let first = one_line_per_segment(d.path(), 3, 5);
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log", "job-2026-10-25T10-00-00.log.2", "job-2026-10-25T10-00-00.log.3"]);
    for n in 1..=3 {
        assert!(!read_text(&segment_path(&first, n)).contains("log rotation"), "segment {n} carries a drop marker although nothing was dropped");
    }
}

#[test]
fn the_segment_after_a_drop_opens_with_one_marker_line() {
    let d = TempDir::new();
    let first = one_line_per_segment(d.path(), 8, 3);
    // Same shape as markerRe in the Go test, checked without a regex crate.
    let text = read_text(&segment_path(&first, 6));
    let line = text.split('\n').next().unwrap();
    assert_eq!(
        line,
        "[2026-10-25 10:00:05] [orch] log rotation: 3 earlier segments of this run were dropped (only the last 3 segments are kept, each at most 27 bytes; see logRotation in docs/daemon-config.md)"
    );
    let last = read_text(&segment_path(&first, 8));
    assert!(last.starts_with("[2026-10-25 10:00:05] [orch] log rotation: 5 earlier segments of this run were dropped"), "segment 8: {last:?}");
    assert!(last.contains("l008"), "the run's own line must follow the marker: {last:?}");
}

// The same words as dropMarkerText in src/log-rotation.ts, singular and plural included.
#[test]
fn the_marker_words_match_the_daemons_for_one_segment() {
    let d = TempDir::new();
    let first = one_line_per_segment(d.path(), 3, 1);
    let want = "[2026-10-25 10:00:05] [orch] log rotation: 2 earlier segments of this run were dropped (only the last 1 segment is kept, each at most 27 bytes; see logRotation in docs/daemon-config.md)\n";
    assert!(read_text(&segment_path(&first, 3)).starts_with(want));
    let d2 = TempDir::new();
    let first2 = one_line_per_segment(d2.path(), 2, 1);
    let want2 = "[2026-10-25 10:00:05] [orch] log rotation: 1 earlier segment of this run was dropped (only the last 1 segment is kept, each at most 27 bytes; see logRotation in docs/daemon-config.md)\n";
    assert!(read_text(&segment_path(&first2, 2)).starts_with(want2));
}

#[test]
fn a_marker_alone_does_not_fill_a_segment() {
    let d = TempDir::new();
    let (mut l, first) = rotating_log(d.path(), 40, 1);
    w(&mut l, "first");
    w(&mut l, &"x".repeat(300));
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log.2"]);
    let text = read_text(&segment_path(&first, 2));
    let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
    assert!(lines.len() == 2 && lines[0].contains("log rotation: 1 earlier segment") && lines[1].ends_with(&"x".repeat(300)), "want the marker then the long line, got {lines:?}");
}

// A writer opened on a run that already has segments appends to the newest one.
#[test]
fn opening_a_run_that_already_has_segments_appends_to_the_newest() {
    let d = TempDir::new();
    let each = entry_of("aaaa").len() as i64;
    let (mut l, first) = rotating_log(d.path(), each * 2, 100);
    for s in ["aaaa", "bbbb", "cccc"] {
        w(&mut l, s);
    }
    l.close();
    let (mut l2, _) = rotating_log(d.path(), each * 2, 100);
    w(&mut l2, "dddd");
    w(&mut l2, "eeee");
    assert_eq!(read_text(&segment_path(&first, 2)), entry_of("cccc") + &entry_of("dddd"));
    assert_eq!(read_text(&segment_path(&first, 3)), entry_of("eeee"));
}

// The daemon writes its markers into the same run: a writer that is behind moves on to the segment the other made.
#[test]
fn a_writer_behind_follows_the_one_that_moved_on() {
    let d = TempDir::new();
    let each = entry_of("aaaa").len() as i64;
    let (mut ahead, first) = rotating_log(d.path(), each * 2, 100);
    let (mut behind, _) = rotating_log(d.path(), each * 2, 100);
    w(&mut ahead, "aaaa");
    w(&mut ahead, "bbbb");
    w(&mut ahead, "cccc");
    w(&mut behind, "late");
    assert_eq!(read_text(&first), entry_of("aaaa") + &entry_of("bbbb"));
    assert_eq!(read_text(&segment_path(&first, 2)), entry_of("cccc") + &entry_of("late"));
}

#[test]
fn two_writers_interleaving_lose_nothing() {
    let d = TempDir::new();
    let (mut a, first) = rotating_log(d.path(), 120, 1000);
    let (mut b, _) = rotating_log(d.path(), 120, 1000);
    let (mut want_a, mut want_b) = (Vec::new(), Vec::new());
    for i in 0..60 {
        let ta = format!("daemon {i}");
        let tb = format!("output {i}:{}", "q".repeat(i % 11));
        w(&mut a, &ta);
        w(&mut b, &tb);
        want_a.push(ta);
        want_b.push(tb);
    }
    let names = file_names(d.path());
    let mut all = read_text(&first);
    for n in 2..=names.len() {
        all.push_str(&read_text(&segment_path(&first, n)));
    }
    let (mut got_a, mut got_b) = (Vec::new(), Vec::new());
    for line in all.trim_end_matches('\n').split('\n') {
        let text = line.strip_prefix("[2026-10-25 10:00:05] ").unwrap_or(line).to_string();
        if text.starts_with("daemon") {
            got_a.push(text);
        } else if text.starts_with("output") {
            got_b.push(text);
        } else {
            panic!("a torn or foreign line: {line:?}");
        }
    }
    assert!(got_a == want_a && got_b == want_b, "a line was lost, duplicated or reordered");
}

#[test]
fn a_completely_blank_or_ansi_only_line_writes_nothing_and_never_rotates() {
    let d = TempDir::new();
    let (mut l, _) = rotating_log(d.path(), 40, 3);
    w(&mut l, "   ");
    w(&mut l, "\x1b[2K");
    same_names(file_names(d.path()), &["job-2026-10-25T10-00-00.log"]);
}

fn js_command(dir: &Path, source: &str) -> String {
    let script = dir.join("job.js");
    fs::write(&script, source).unwrap();
    format!("node \"{}\"", script.display())
}

// The whole supervisor, with a real job printing more than the limit: the spec is where the limits come from.
#[test]
fn run_rotates_the_log_of_a_real_job_from_the_spec() {
    let d = TempDir::new();
    let cmd = js_command(d.path(), r#"for (let i = 0; i < 40; i++) console.log("row " + String(i).padStart(3, "0") + " " + "p".repeat(20)); process.exit(0)"#);
    let s = start_run(TestSpec { command: cmd, rotation: Some(LogRotation { max_bytes: 300, keep_segments: 1000 }), ..Default::default() });
    let dir = s.path().to_path_buf();
    s.done.join().unwrap();
    let segs: Vec<String> = file_names(&dir).into_iter().filter(|n| n.starts_with("run.log")).collect();
    assert!(segs.len() >= 3, "expected the output to span several segments, got {segs:?}");
    let mut all = read_text(&dir.join("run.log"));
    for n in 2..=segs.len() {
        all.push_str(&read_text(&dir.join(format!("run.log.{n}"))));
    }
    for i in 0..40 {
        assert!(all.contains(&format!("row {i:03} ")), "row {i} is missing from the segments");
    }
    for n in &segs {
        let size = fs::metadata(dir.join(n)).unwrap().len();
        assert!(size <= 300, "{n} is {size} bytes, over the 300 limit although no line is that long");
    }
}

#[test]
fn run_without_limits_in_the_spec_writes_one_file() {
    let d = TempDir::new();
    let cmd = js_command(d.path(), r#"for (let i = 0; i < 40; i++) console.log("row " + i + " " + "p".repeat(40)); process.exit(0)"#);
    let s = start_run(TestSpec { command: cmd, ..Default::default() });
    let dir = s.path().to_path_buf();
    s.done.join().unwrap();
    for n in file_names(&dir) {
        assert!(!n.starts_with("run.log."), "no limit was given, yet {n} exists");
    }
}

#[test]
fn a_spec_with_a_negative_limit_is_refused() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "0"), rotation: Some(LogRotation { max_bytes: -5, keep_segments: 3 }), ..Default::default() });
    let dir = s.path().to_path_buf();
    let code = s.done.join().unwrap();
    assert!(code != 0, "a negative maxBytes must not start the job");
    let status = fs::read_to_string(dir.join("status.json")).unwrap();
    assert!(status.contains("\"failed-to-start\"") && status.contains("logRotation"), "want failed-to-start naming logRotation, got {status}");
}
