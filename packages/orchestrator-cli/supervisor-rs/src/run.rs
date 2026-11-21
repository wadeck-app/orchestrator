// orchestrator-supervisor runs ONE job outside the daemon, so the daemon can be stopped, updated and started again
// at any moment without touching the job. Rust port of run.go, same file contract:
//
//   spec.json     written by the daemon before starting us: what to run, where the output goes, the timeout.
//   status.json   written by us, atomically, at every change: who runs the job and how it ended.
//   heartbeat     touched by us every spec.heartbeatMs while the job runs: proof that WE are alive.
//   kill          created by the daemon to ask for the job's whole process tree to be ended.

use crate::json::{self, quote, Value};
use crate::proc;
use crate::runlog::{copy_lines, os_msg, LogRotation, RunLog};
use crate::timefmt::{rfc3339_nano, sys_now};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_HEARTBEAT_MS: i64 = 2000;
pub const DEFAULT_KILL_GRACE_MS: i64 = 300;
const MAX_CONTROL_POLL_MS: u64 = 250;
const KILL_READ_ATTEMPTS: u32 = 100;

/// spec.json. The `context` block the daemon adds (jobId, label, trigger, ...) is read by nobody here: like the Go
/// supervisor, any unknown field is accepted and ignored.
#[derive(Default, Debug)]
pub struct Spec {
    /// Run through the platform shell (cmd.exe /d /s /c, sh -c).
    pub command: String,
    pub cwd: String,
    /// Receives stdout and stderr, appended. Segment 1 of the run log.
    pub log_path: String,
    pub log_rotation: Option<LogRotation>,
    /// Ends the job when positive.
    pub timeout_seconds: i64,
    pub heartbeat_ms: i64,
    pub kill_grace_ms: i64,
}

/// status.json. state is "running", "exited" or "failed-to-start". Field order and omitempty rules are Go's.
#[derive(Clone, Default, Debug)]
pub struct Status {
    pub state: String,
    pub supervisor_pid: u32,
    pub supervisor_started_at: String,
    pub child_pid: u32,
    pub started_at: String,
    pub finished_at: String,
    /// Absent until the job ends, and absent when it ended on a signal.
    pub exit_code: Option<i64>,
    pub signal: String,
    pub killed: bool,
    pub kill_reason: String,
    pub timed_out: bool,
    pub error: String,
}

impl Status {
    pub fn to_json(&self) -> String {
        let mut s = format!(
            "{{\"state\":{},\"supervisorPid\":{},\"supervisorStartedAt\":{}",
            quote(&self.state),
            self.supervisor_pid,
            quote(&self.supervisor_started_at)
        );
        if self.child_pid != 0 {
            s.push_str(&format!(",\"childPid\":{}", self.child_pid));
        }
        let strings = [("startedAt", &self.started_at)];
        for (k, v) in strings {
            if !v.is_empty() {
                s.push_str(&format!(",\"{k}\":{}", quote(v)));
            }
        }
        if !self.finished_at.is_empty() {
            s.push_str(&format!(",\"finishedAt\":{}", quote(&self.finished_at)));
        }
        if let Some(code) = self.exit_code {
            s.push_str(&format!(",\"exitCode\":{code}"));
        }
        if !self.signal.is_empty() {
            s.push_str(&format!(",\"signal\":{}", quote(&self.signal)));
        }
        if self.killed {
            s.push_str(",\"killed\":true");
        }
        if !self.kill_reason.is_empty() {
            s.push_str(&format!(",\"killReason\":{}", quote(&self.kill_reason)));
        }
        if self.timed_out {
            s.push_str(",\"timedOut\":true");
        }
        if !self.error.is_empty() {
            s.push_str(&format!(",\"error\":{}", quote(&self.error)));
        }
        s.push('}');
        s
    }
}

fn stamp(t: Duration) -> String {
    rfc3339_nano(t)
}

/// Replaces status.json in one rename, so a reader never sees half of it.
pub fn write_status(run_dir: &Path, st: &Status) -> io::Result<()> {
    let tmp = run_dir.join(format!("status.json.{}.tmp", std::process::id()));
    fs::write(&tmp, st.to_json())?;
    // A rename can fail for a moment on Windows while a reader or a virus scanner holds the target: the final
    // status carries the exit code, so it is worth a few tries before giving up.
    let target = run_dir.join("status.json");
    let mut last = None;
    for attempt in 1..=6u64 {
        match fs::rename(&tmp, &target) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        thread::sleep(Duration::from_millis(attempt * 25));
    }
    Err(last.unwrap())
}

// Go's encoding/json type errors, field by field.
fn type_error(field: &str, ty: &str, v: &Value) -> String {
    // Go names the literal only when a number does not fit the integer it goes into.
    let kind = match v {
        Value::Num(n) if ty == "int" => format!("number {n}"),
        other => other.kind().to_string(),
    };
    format!("json: cannot unmarshal {kind} into Go struct field {field} of type {ty}")
}

/// The last non-null member called `name` (Go matches keys case-insensitively and lets a later duplicate win).
fn member<'a>(obj: &'a [(String, Value)], name: &str) -> Vec<&'a Value> {
    obj.iter().filter(|(k, v)| k.eq_ignore_ascii_case(name) && !matches!(v, Value::Null)).map(|(_, v)| v).collect()
}

fn string_field(obj: &[(String, Value)], name: &str, path: &str) -> Result<String, String> {
    let mut out = String::new();
    for v in member(obj, name) {
        match v {
            Value::Str(s) => out = s.clone(),
            other => return Err(type_error(&format!("{path}{name}"), "string", other)),
        }
    }
    Ok(out)
}

fn int_field(obj: &[(String, Value)], name: &str, path: &str) -> Result<i64, String> {
    let mut out = 0;
    for v in member(obj, name) {
        match v {
            Value::Num(n) => match n.parse::<i64>() {
                Ok(i) => out = i,
                Err(_) => return Err(type_error(&format!("{path}{name}"), "int", v)),
            },
            other => return Err(type_error(&format!("{path}{name}"), "int", other)),
        }
    }
    Ok(out)
}

fn parse_spec(data: &[u8]) -> Result<Spec, String> {
    let value = json::parse(data)?;
    let mut spec = Spec::default();
    let obj = match value {
        Value::Null => return Ok(spec),
        Value::Obj(o) => o,
        other => return Err(format!("json: cannot unmarshal {} into Go value of type main.Spec", other.kind())),
    };
    spec.command = string_field(&obj, "command", "Spec.")?;
    spec.cwd = string_field(&obj, "cwd", "Spec.")?;
    spec.log_path = string_field(&obj, "logPath", "Spec.")?;
    spec.timeout_seconds = int_field(&obj, "timeoutSeconds", "Spec.")?;
    spec.heartbeat_ms = int_field(&obj, "heartbeatMs", "Spec.")?;
    spec.kill_grace_ms = int_field(&obj, "killGraceMs", "Spec.")?;
    for v in member(&obj, "logRotation") {
        match v {
            Value::Obj(r) => {
                let mut rot = spec.log_rotation.unwrap_or_default();
                rot.max_bytes = int_field(r, "maxBytes", "Spec.logRotation.")?;
                rot.keep_segments = int_field(r, "keepSegments", "Spec.logRotation.")?;
                spec.log_rotation = Some(rot);
            }
            other => return Err(type_error("Spec.logRotation", "main.LogRotation", other)),
        }
    }
    Ok(spec)
}

pub fn read_spec(run_dir: &Path, run_dir_text: &str) -> Result<Spec, String> {
    let path = run_dir.join("spec.json");
    let data = fs::read(&path).map_err(|e| {
        format!(
            "cannot read spec.json in {run_dir_text}: open {}: {}. The daemon writes it before starting the supervisor",
            path.display(),
            os_msg(&e)
        )
    })?;
    let spec = parse_spec(&data).map_err(|e| format!("spec.json in {run_dir_text} is not valid JSON: {e}"))?;
    if spec.command.is_empty() || spec.log_path.is_empty() {
        return Err(format!("spec.json in {run_dir_text} needs a command and a logPath"));
    }
    if let Some(r) = spec.log_rotation {
        if r.max_bytes < 0 || (r.max_bytes > 0 && r.keep_segments < 1) {
            return Err(format!(
                "spec.json in {run_dir_text} has an invalid logRotation {{MaxBytes:{} KeepSegments:{}}}: maxBytes must be 0 (no rotation) or more, and keepSegments at least 1 when maxBytes is set",
                r.max_bytes, r.keep_segments
            ));
        }
    }
    Ok(spec)
}

/// Records one more beat: the counter is the evidence, the modification time is only a convenience.
fn touch(path: &Path, beat: u64) {
    if let Ok(mut f) = fs::File::create(path) {
        if f.write_all(beat.to_string().as_bytes()).is_ok() {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
    }
}

/// Go's %q for the characters that can show up in a command or a path.
fn go_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn file_exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// The content of the kill file: why the daemon asked ("manual", "resource-limit").
///
/// The file is seen to exist before it is read, and a read can fail or find nothing for a moment even though the daemon
/// writes it whole (a scanner or indexer holding a new file on Windows; an older daemon writing it in place). It is read
/// again for about two seconds first, and when it never becomes readable the record says why instead of a bare
/// "unspecified". `pause` is the wait between two reads; a test replaces it.
pub fn kill_reason(path: &Path, pause: &mut dyn FnMut()) -> String {
    let mut last_err: Option<String> = None;
    for attempt in 0..KILL_READ_ATTEMPTS {
        if attempt > 0 {
            pause();
        }
        match fs::read(path) {
            Ok(data) => {
                last_err = None;
                let text = String::from_utf8_lossy(&data);
                let t = text.trim();
                if !t.is_empty() {
                    return t.to_string();
                }
            }
            Err(e) => last_err = Some(format!("open {}: {}", path.display(), os_msg(&e))),
        }
    }
    match last_err {
        Some(e) => format!("unspecified (kill file unreadable: {e})"),
        None => "unspecified".to_string(),
    }
}

fn read_kill_reason(path: &Path) -> String {
    kill_reason(path, &mut || thread::sleep(Duration::from_millis(20)))
}

/// Supervises the job described by <run_dir>/spec.json until it ends, and returns the process exit code of the
/// supervisor itself: 0 whenever the job was run to its end (whatever the job's own code was, which is in status.json),
/// non-zero when the job could not be started.
pub fn run(run_dir_text: &str) -> i32 {
    let run_dir = PathBuf::from(run_dir_text);
    let base = Status { supervisor_pid: std::process::id(), supervisor_started_at: stamp(sys_now()), ..Default::default() };

    let fail_to_start = |message: String| -> i32 {
        let mut st = base.clone();
        st.state = "failed-to-start".into();
        st.finished_at = stamp(sys_now());
        st.error = message.clone();
        let _ = write_status(&run_dir, &st);
        eprintln!("orchestrator-supervisor: {message}");
        1
    };

    let spec = match read_spec(&run_dir, run_dir_text) {
        Ok(s) => s,
        Err(e) => return fail_to_start(e),
    };
    let rotation = spec.log_rotation.unwrap_or_default();
    let log = match RunLog::open(Path::new(&spec.log_path), rotation, sys_now) {
        Ok(l) => Arc::new(Mutex::new(l)),
        Err(e) => return fail_to_start(format!("cannot open the run log {}: {e}", spec.log_path)),
    };

    let mut cmd = proc::build_command(&spec);
    if !spec.cwd.is_empty() {
        cmd.current_dir(&spec.cwd);
    }
    // The supervisor, not the daemon, reads the job's output, so it keeps flowing while the daemon is away. Go gives a
    // job no stdin (the null device): std would inherit ours.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let started_at = Instant::now();
    let started_stamp = stamp(sys_now());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return fail_to_start(format!(
                "cannot start {} (cwd {}): {}{}",
                go_quote(&spec.command),
                go_quote(&spec.cwd),
                proc::start_error_prefix(),
                os_msg(&e)
            ))
        }
    };
    let child_pid = child.id();
    let mut readers = Vec::new();
    for (stream, prefix) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn io::Read + Send>), ""),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn io::Read + Send>), "[stderr] "),
    ] {
        if let Some(r) = stream {
            let log = Arc::clone(&log);
            readers.push(thread::spawn(move || copy_lines(&log, r, prefix)));
        }
    }

    let mut running = base.clone();
    running.state = "running".into();
    running.child_pid = child_pid;
    running.started_at = started_stamp;
    if let Err(e) = write_status(&run_dir, &running) {
        // Without a status file nobody can adopt this run: end the job rather than leave one nobody can see.
        proc::end_tree(child_pid, &spec);
        for r in readers {
            let _ = r.join();
        }
        let _ = child.wait();
        return fail_to_start(format!("cannot write status.json in {run_dir_text}: open {}: {}", run_dir.join("status.json").display(), os_msg(&e)));
    }

    // Wait must not run before every read of the pipes is done. It also means the run ends when the job's output
    // closes, as node's "close" event did: a background process that kept the pipe open keeps the run open.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for r in readers {
            let _ = r.join();
        }
        let _ = tx.send(child.wait());
    });

    let heartbeat = Duration::from_millis(if spec.heartbeat_ms > 0 { spec.heartbeat_ms } else { DEFAULT_HEARTBEAT_MS } as u64);
    let poll = heartbeat.min(Duration::from_millis(MAX_CONTROL_POLL_MS));
    let heartbeat_path = run_dir.join("heartbeat");
    let kill_path = run_dir.join("kill");
    let mut beats: u64 = 1;
    touch(&heartbeat_path, beats);
    let mut next_beat = Instant::now() + heartbeat;
    let mut next_poll = Instant::now() + poll;

    let deadline = if spec.timeout_seconds > 0 {
        Some(started_at + Duration::from_secs(spec.timeout_seconds as u64))
    } else {
        None
    };
    let mut fin = running.clone();
    let exit_status = loop {
        let wait = next_beat.min(next_poll).saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(status) => break status,
            Err(RecvTimeoutError::Disconnected) => {
                return fail_to_start("internal error: the thread waiting for the job ended without a result".into());
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        if now >= next_beat {
            beats += 1;
            touch(&heartbeat_path, beats);
            next_beat += heartbeat;
        }
        if now >= next_poll {
            next_poll += poll;
            if !fin.killed && file_exists(&kill_path) {
                fin.killed = true;
                fin.kill_reason = read_kill_reason(&kill_path);
                spawn_end_tree(child_pid, &spec);
            } else if !fin.timed_out && deadline.is_some_and(|d| Instant::now() > d) {
                fin.timed_out = true;
                spawn_end_tree(child_pid, &spec);
            }
        }
    };

    // The daemon ends the tree itself as well as writing `kill`, so the job can be gone before the poll above
    // ever saw the file. A kill asked for while it was ending is still a kill, and the reason must survive.
    if !fin.killed && file_exists(&kill_path) {
        fin.killed = true;
        fin.kill_reason = read_kill_reason(&kill_path);
    }
    fin.state = "exited".into();
    fin.finished_at = stamp(sys_now());
    if let Ok(st) = &exit_status {
        let (code, signal) = proc::exit_of(st);
        fin.exit_code = code;
        fin.signal = signal;
    }
    // The one write that must not be lost: it carries the exit code, and without it the run reads "running" for ever.
    // A reader or a virus scanner can hold the file for a moment on Windows, so keep trying for a good while.
    let mut write_err = None;
    for _ in 0..60 {
        match write_status(&run_dir, &fin) {
            Ok(()) => {
                write_err = None;
                break;
            }
            Err(e) => write_err = Some(e),
        }
        thread::sleep(Duration::from_millis(250));
    }
    match write_err {
        None => 0,
        Some(e) => {
            eprintln!("orchestrator-supervisor: cannot write the final status.json: {}", os_msg(&e));
            1
        }
    }
}

fn spawn_end_tree(pid: u32, spec: &Spec) {
    let spec = Spec { kill_grace_ms: spec.kill_grace_ms, ..Default::default() };
    thread::spawn(move || proc::end_tree(pid, &spec));
}
