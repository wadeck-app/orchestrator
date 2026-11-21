// Port of run_test.go. The supervisor owns one job outside the daemon, so that the daemon can restart at any moment.
// These tests pin the file contract the daemon relies on: what is written when the job ends normally, fails, is
// killed on request, times out, or never starts.

use crate::ansi::strip_ansi;
use crate::json::{self, quote, Value};
use crate::run::{kill_reason, run};
use crate::runlog::LogRotation;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// A unique temp folder, removed (best effort) on drop: no tempfile crate.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("sup-rs-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// node is on every machine that runs the daemon, and its quoting works the same under cmd.exe and sh.
fn js_command(dir: &Path, source: &str) -> String {
    let script = dir.join("job.js");
    fs::write(&script, source).unwrap();
    format!("node \"{}\"", script.display())
}

#[derive(Default)]
pub struct TestSpec {
    pub command: String,
    pub cwd: String,
    pub rotation: Option<LogRotation>,
    pub timeout_seconds: i64,
    pub heartbeat_ms: i64,
}

fn spec_json(s: &TestSpec, log_path: &Path) -> String {
    let mut out = format!("{{\"command\":{},\"logPath\":{}", quote(&s.command), quote(&log_path.display().to_string()));
    if !s.cwd.is_empty() {
        out.push_str(&format!(",\"cwd\":{}", quote(&s.cwd)));
    }
    if let Some(r) = s.rotation {
        out.push_str(&format!(",\"logRotation\":{{\"maxBytes\":{},\"keepSegments\":{}}}", r.max_bytes, r.keep_segments));
    }
    if s.timeout_seconds != 0 {
        out.push_str(&format!(",\"timeoutSeconds\":{}", s.timeout_seconds));
    }
    out.push_str(&format!(",\"heartbeatMs\":{}}}", s.heartbeat_ms));
    out
}

pub struct Started {
    pub dir: TempDir,
    pub done: JoinHandle<i32>,
}

impl Started {
    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

pub fn start_run(mut spec: TestSpec) -> Started {
    let dir = TempDir::new();
    if spec.heartbeat_ms == 0 {
        spec.heartbeat_ms = 50;
    }
    fs::write(dir.path().join("spec.json"), spec_json(&spec, &dir.path().join("run.log"))).unwrap();
    let run_dir = dir.path().display().to_string();
    let done = thread::spawn(move || run(&run_dir));
    Started { dir, done }
}

/// Status as the tests read it: the raw object, to check field names too.
struct St(Vec<(String, Value)>);

impl St {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    fn str(&self, k: &str) -> String {
        match self.get(k) {
            Some(Value::Str(s)) => s.clone(),
            _ => String::new(),
        }
    }
    fn int(&self, k: &str) -> Option<i64> {
        match self.get(k) {
            Some(Value::Num(n)) => n.parse().ok(),
            _ => None,
        }
    }
    fn bool(&self, k: &str) -> bool {
        matches!(self.get(k), Some(Value::Bool(true)))
    }
}

fn read_status(dir: &Path) -> St {
    let data = fs::read(dir.join("status.json")).expect("status.json");
    match json::parse(&data) {
        Ok(Value::Obj(o)) => St(o),
        _ => panic!("status.json is not a JSON object: {}", String::from_utf8_lossy(&data)),
    }
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if ok() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

fn finish(s: Started) -> (TempDir, i32) {
    // join cannot time out: the harness timeout is the guard, as the job itself always ends in these tests.
    let code = s.done.join().expect("the supervisor thread panicked");
    (s.dir, code)
}

fn write_kill(dir: &Path) {
    fs::write(dir.join("kill"), "test").unwrap();
}

fn status_has_running(dir: &Path) -> bool {
    fs::read_to_string(dir.join("status.json")).map(|d| d.contains("\"running\"")).unwrap_or(false)
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn GetExitCodeProcess(h: *mut core::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
    }
    unsafe {
        let h = OpenProcess(0x1000, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == 259
    }
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    // Signal 0 checks that the process exists without sending anything.
    unsafe { kill(pid as i32, 0) == 0 }
}

fn text_of(dir: &Path, name: &str) -> String {
    String::from_utf8_lossy(&fs::read(dir.join(name)).unwrap_or_default()).into_owned()
}

/// Splits a run log into lines with the "[YYYY-MM-DD HH:MM:SS] " stamp removed; panics when a line has no stamp.
fn unstamped(log: &str) -> Vec<String> {
    log.trim_end_matches('\n')
        .split('\n')
        .map(|line| {
            let b = line.as_bytes();
            let ok = b.len() >= 22
                && b[0] == b'['
                && b[5] == b'-'
                && b[8] == b'-'
                && b[11] == b' '
                && b[14] == b':'
                && b[17] == b':'
                && b[20] == b']'
                && b[21] == b' '
                && b[1..5].iter().chain(&b[6..8]).chain(&b[9..11]).chain(&b[12..14]).chain(&b[15..17]).chain(&b[18..20]).all(u8::is_ascii_digit);
            assert!(ok, "every line starts with a UTC timestamp, got {line:?}");
            line[22..].to_string()
        })
        .collect()
}

#[test]
fn records_the_exit_code_and_the_output_of_a_finished_job() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), r#"console.log("hello"); console.error("oops"); process.exit(3)"#), ..Default::default() });
    let (dir, _) = finish(s);
    let st = read_status(dir.path());
    assert_eq!(st.str("state"), "exited");
    assert_eq!(st.int("exitCode"), Some(3));
    assert!(!st.str("finishedAt").is_empty() && !st.str("startedAt").is_empty() && st.int("childPid").unwrap_or(0) != 0 && st.int("supervisorPid").unwrap_or(0) != 0, "a finished run must say when it started and ended and who ran it");
    let log = text_of(dir.path(), "run.log");
    assert!(log.contains("hello") && log.contains("oops"), "stdout and stderr both belong in the run log, got {log:?}");
}

#[test]
fn reports_a_running_job_before_it_ends() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setTimeout(() => {}, 3000)"), ..Default::default() });
    wait_for("status running", || status_has_running(s.path()));
    let st = read_status(s.path());
    assert!(st.int("childPid").unwrap_or(0) != 0 && st.get("exitCode").is_none() && st.str("finishedAt").is_empty(), "a running job has a pid and no end yet");
    write_kill(s.path());
    finish(s);
}

#[test]
fn touches_the_heartbeat_while_the_job_runs() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setTimeout(() => {}, 3000)"), ..Default::default() });
    let beat = s.path().join("heartbeat");
    let mut first = None;
    wait_for("first heartbeat", || match fs::metadata(&beat).and_then(|m| m.modified()) {
        Ok(t) => {
            first = Some(t);
            true
        }
        Err(_) => false,
    });
    wait_for("heartbeat to move", || fs::metadata(&beat).and_then(|m| m.modified()).map(|t| t > first.unwrap()).unwrap_or(false));
    write_kill(s.path());
    finish(s);
}

#[test]
fn a_kill_request_ends_the_whole_job_and_says_so() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setInterval(() => {}, 1000)"), ..Default::default() });
    wait_for("the job to run", || status_has_running(s.path()));
    let pid = read_status(s.path()).int("childPid").unwrap() as u32;
    write_kill(s.path());
    let (dir, _) = finish(s);
    let st = read_status(dir.path());
    assert!(st.str("state") == "exited" && st.bool("killed"), "a killed job is exited and flagged killed");
    assert!(!process_alive(pid), "the job's process {pid} survived its kill");
}

#[test]
fn a_timeout_ends_the_job_without_the_daemon() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setInterval(() => {}, 1000)"), timeout_seconds: 1, ..Default::default() });
    let (dir, _) = finish(s);
    let st = read_status(dir.path());
    assert!(st.bool("timedOut") && st.str("state") == "exited", "want timed out and exited");
    assert!(!process_alive(st.int("childPid").unwrap() as u32), "the job's process survived its timeout");
}

#[test]
fn a_job_that_cannot_start_is_reported_not_lost() {
    let d = TempDir::new();
    let cwd = d.path().join("does-not-exist").display().to_string();
    let s = start_run(TestSpec { command: js_command(d.path(), "process.exit(0)"), cwd, ..Default::default() });
    let (dir, code) = finish(s);
    let st = read_status(dir.path());
    assert!(st.str("state") == "failed-to-start" && !st.str("error").is_empty(), "a job that did not start says why");
    assert!(code != 0, "the supervisor must not exit 0 for a job that never started");
}

#[test]
fn refuses_a_spec_it_cannot_read() {
    let d = TempDir::new();
    assert!(run(&d.path().display().to_string()) != 0, "a run folder without spec.json must fail");
    let st = read_status(d.path());
    assert!(st.str("state") == "failed-to-start" && st.str("error").contains("spec.json"), "the status must name the file that is missing");
}

#[test]
fn never_leaves_a_half_written_status() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setTimeout(() => {}, 1500)"), ..Default::default() });
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        if let Ok(data) = fs::read(s.path().join("status.json")) {
            assert!(json::parse(&data).is_ok(), "a reader saw a half-written status.json: {}", String::from_utf8_lossy(&data));
        }
        thread::sleep(Duration::from_millis(2));
    }
    write_kill(s.path());
    finish(s);
}

// The run log must read exactly as it did when the daemon wrote it, so that nothing downstream (the log
// viewer, the log search, the progress engine) can tell whether the daemon restarted during the run.
#[test]
fn writes_the_run_log_in_the_format_the_daemon_used() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), r#"console.log("first"); console.log(""); console.log("  padded   "); console.error("oops")"#), ..Default::default() });
    let (dir, _) = finish(s);
    let mut texts = unstamped(&text_of(dir.path(), "run.log"));
    texts.sort();
    let mut want = vec!["first".to_string(), "  padded".to_string(), "[stderr] oops".to_string()];
    want.sort();
    assert_eq!(texts, want, "blank lines are dropped, trailing spaces trimmed and stderr prefixed");
}

#[test]
fn keeps_a_line_that_does_not_end_with_a_newline() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), r#"process.stdout.write("no newline at the end")"#), ..Default::default() });
    let (dir, _) = finish(s);
    let log = text_of(dir.path(), "run.log");
    assert!(log.contains("] no newline at the end"), "the last partial line must not be lost, got {log:?}");
}

#[test]
fn records_why_the_daemon_asked_for_the_kill() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setInterval(() => {}, 1000)"), ..Default::default() });
    wait_for("the job to run", || status_has_running(s.path()));
    fs::write(s.path().join("kill"), "resource-limit\n").unwrap();
    let (dir, _) = finish(s);
    let st = read_status(dir.path());
    assert!(st.bool("killed") && st.str("killReason") == "resource-limit", "the reason in the kill file is kept");
}

// A clock jump (sleep/resume, a manual change) must not be able to make a dead supervisor look alive or a live
// one look dead, so the heartbeat carries a counter and not only a modification time.
#[test]
fn heartbeat_carries_a_counter_that_keeps_growing() {
    let d = TempDir::new();
    let s = start_run(TestSpec { command: js_command(d.path(), "setTimeout(() => {}, 3000)"), ..Default::default() });
    let read = || fs::read_to_string(s.path().join("heartbeat")).ok().and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(-1);
    let mut first = -1;
    wait_for("a first heartbeat counter", || {
        first = read();
        first >= 0
    });
    wait_for("the counter to grow", || read() > first);
    write_kill(s.path());
    finish(s);
}

// The daemon writes `kill` and then ends the tree itself, so on a fast machine the job can be gone before the
// supervisor next looks at the file. The reason must be recorded all the same: it is what tells a kill from a crash.
#[test]
fn records_the_kill_reason_even_when_the_job_died_before_the_next_look() {
    let d = TempDir::new();
    // A heartbeat this slow makes the supervisor look for `kill` only every 250 ms, and the job ends sooner.
    let s = start_run(TestSpec { command: js_command(d.path(), "setTimeout(() => {}, 100)"), heartbeat_ms: 5000, ..Default::default() });
    wait_for("the job to run", || status_has_running(s.path()));
    fs::write(s.path().join("kill"), "manual").unwrap();
    let (dir, _) = finish(s);
    let st = read_status(dir.path());
    assert!(st.bool("killed") && st.str("killReason") == "manual", "a kill requested while the job was ending must still be recorded");
}

// A job that prints colour regardless of the environment must not put it in the run log: the file is read by
// editors, grep, the dashboard and agents. The daemon strips the same way for a job it spawns itself.
#[test]
fn strips_escape_sequences_from_the_jobs_output_but_not_its_carriage_returns() {
    let d = TempDir::new();
    let source = r##"const E = String.fromCharCode(27), B = String.fromCharCode(7), ST = E + String.fromCharCode(92);
console.log(E + '[31mred' + E + '[0m ' + E + ']0;title' + B + E + ']8;;http://x.test' + ST + 'link' + E + ']8;;' + ST + ' ' + E + '[2K' + E + '[1Gdone');
console.log(E + '[2K');
console.error(E + '[33mwarn' + E + '[39m on stderr');
process.stdout.write('10%\r20%\r100%\n');"##;
    let s = start_run(TestSpec { command: js_command(d.path(), source), ..Default::default() });
    let (dir, _) = finish(s);
    let log = text_of(dir.path(), "run.log");
    assert!(!log.contains('\x1b'), "an ESC reached the run log: {log:?}");
    let mut texts = unstamped(&log);
    texts.sort();
    let mut want = vec!["10%\r20%\r100%".to_string(), "[stderr] warn on stderr".to_string(), "red link done".to_string()];
    want.sort();
    assert_eq!(texts, want, "a line that is only an erase code writes nothing");
}

#[test]
fn strip_ansi_table() {
    let (esc, bel, st) = ("\x1b", "\x07", "\x1b\\");
    // The same table as orchestrator-cli/test/ansi-cases.js.
    let cases: Vec<(&str, String, &str)> = vec![
        ("plain", "hello world".into(), "hello world"),
        ("SGR", format!("{esc}[31mred{esc}[0m"), "red"),
        ("256 and truecolour", format!("{esc}[38;5;208ma{esc}[38;2;1;2;3mb{esc}[0m"), "ab"),
        ("SGR with no parameter", format!("{esc}[mx"), "x"),
        ("private mode", format!("{esc}[?25lx{esc}[?25h"), "x"),
        ("erase", format!("{esc}[2K{esc}[1Gdone"), "done"),
        ("cursor up and clear", format!("{esc}[1A{esc}[2Jx"), "x"),
        ("OSC with BEL", format!("{esc}]0;my title{bel}text"), "text"),
        ("OSC hyperlink with ST", format!("{esc}]8;;http://x.test{st}link{esc}]8;;{st}"), "link"),
        ("OSC cut at the end", format!("before{esc}]0;title never ended"), "before"),
        ("DCS with ST", format!("{esc}Pq#0;2;0;0;0{st}after"), "after"),
        ("lone ESC sequences", format!("{esc}cA{esc}7B{esc}8C"), "ABC"),
        ("charset", format!("{esc}(Bx"), "x"),
        ("lone ESC at the end", format!("a{esc}"), "a"),
        ("carriage returns stay", "10%\r20%\r100%".into(), "10%\r20%\r100%"),
        ("carriage return with erase", format!("\r{esc}[2Kdone"), "\rdone"),
        ("brackets without ESC", "array[0] and [31m".into(), "array[0] and [31m"),
        ("non-ASCII", format!("{esc}[32mété ✓{esc}[0m"), "été ✓"),
    ];
    for (what, input, want) in cases {
        let got = String::from_utf8(strip_ansi(input.as_bytes())).unwrap();
        assert_eq!(got, want, "{what}");
    }
}

// The kill file is polled for existence and read in the next step. A file that exists but cannot be read for a moment
// (a scanner or indexer holding a new file on Windows) used to be recorded as the reason "unspecified": the reason is
// read again before giving up.
#[test]
fn kill_reason_is_read_again_when_the_file_cannot_be_read_yet() {
    let d = TempDir::new();
    let path = d.path().join("kill");
    // reading a directory fails, like a file held by another process
    fs::create_dir(&path).unwrap();
    let mut pauses = 0;
    let got = kill_reason(&path, &mut || {
        pauses += 1;
        if pauses == 3 {
            // the other process lets go: the reason is there
            let _ = fs::remove_dir(&path);
            let _ = fs::write(&path, "timeout\n");
        }
    });
    assert_eq!(got, "timeout", "expected the reason once readable, after {pauses} pauses");
}

#[test]
fn kill_reason_says_why_when_it_never_becomes_readable() {
    let d = TempDir::new();
    let path = d.path().join("kill");
    fs::create_dir(&path).unwrap();
    let got = kill_reason(&path, &mut || {});
    assert!(got.starts_with("unspecified (kill file unreadable: "), "an unreadable kill file must say so, got {got:?}");
}

#[test]
fn kill_reason_of_an_empty_file_is_unspecified() {
    let d = TempDir::new();
    let path = d.path().join("kill");
    fs::write(&path, "").unwrap();
    assert_eq!(kill_reason(&path, &mut || {}), "unspecified");
}

// Parity extras (not in the Go tests): the daemon's `context` block and unknown fields are accepted and ignored.
#[test]
fn accepts_the_context_block_and_ignores_unknown_fields() {
    let d = TempDir::new();
    let dir = TempDir::new();
    let cmd = js_command(d.path(), "process.exit(0)");
    let spec = format!(
        "{{\"command\":{},\"logPath\":{},\"heartbeatMs\":50,\"context\":{{\"jobId\":\"j\",\"label\":\"l\",\"trigger\":\"cron\",\"retryAttempt\":2,\"dryRun\":false}},\"future\":[1,2]}}",
        quote(&cmd),
        quote(&dir.path().join("run.log").display().to_string())
    );
    fs::write(dir.path().join("spec.json"), spec).unwrap();
    assert_eq!(run(&dir.path().display().to_string()), 0);
    assert_eq!(read_status(dir.path()).str("state"), "exited");
}
