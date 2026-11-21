// Platform part: how the job is started, how its tree is ended, how its end is reported.
// The Windows branch is the one compiled and tested here. The Unix branch (#[cfg(unix)]) is NOT compiled or tested.

use crate::run::Spec;
use std::process::Command;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{ExitStatus, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    /// cmd.exe /d /s /c "<command>", the command line handed over verbatim (raw_arg): no escaping of the quotes cmd.exe expects.
    pub fn build_command(spec: &Spec) -> Command {
        let mut cmd = Command::new("cmd.exe");
        cmd.raw_arg(format!("/d /s /c \"{}\"", spec.command));
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        cmd
    }

    /// Go reports a failed start as "fork/exec <resolved program>: <os error>"; the program is cmd.exe found on PATH.
    pub fn start_error_prefix() -> String {
        let found = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("cmd.exe")).find(|c| c.is_file()));
        match found {
            Some(p) => format!("fork/exec {}: ", p.display()),
            None => "fork/exec cmd.exe: ".to_string(),
        }
    }

    /// taskkill /T /F walks the tree itself.
    pub fn end_tree(pid: u32, _spec: &Spec) {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    /// Go's ExitCode() is the unsigned code widened to int: 0xC0000005 is 3221225477, not negative.
    pub fn exit_of(st: &ExitStatus) -> (Option<i64>, String) {
        (Some(st.code().unwrap_or(0) as u32 as i64), String::new())
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::ExitStatus;
    use std::time::Duration;

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    const SIGKILL: i32 = 9;

    /// /bin/sh -c "<command>" in a process group of its own, so that ending it reaches everything it started.
    pub fn build_command(spec: &Spec) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&spec.command);
        cmd.process_group(0);
        cmd
    }

    /// Go's message for a failed start is the os error alone for a missing cwd ("chdir ...") or "fork/exec /bin/sh: ..."
    /// otherwise; not verified here (no Unix host): left empty, so only the OS message is reported.
    pub fn start_error_prefix() -> String {
        String::new()
    }

    /// SIGTERM to the whole group, SIGKILL once the grace period has passed.
    pub fn end_tree(pid: u32, spec: &Spec) {
        let grace = if spec.kill_grace_ms > 0 { spec.kill_grace_ms } else { crate::run::DEFAULT_KILL_GRACE_MS };
        unsafe {
            kill(-(pid as i32), SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(grace as u64));
        unsafe {
            kill(-(pid as i32), SIGKILL);
        }
    }

    /// Go's syscall.Signal.String() on Linux (the table of zerrors_linux_*.go; macOS names differ for some signals).
    fn signal_name(sig: i32) -> String {
        const NAMES: [&str; 32] = [
            "", "hangup", "interrupt", "quit", "illegal instruction", "trace/breakpoint trap", "aborted", "bus error",
            "floating point exception", "killed", "user defined signal 1", "segmentation fault", "user defined signal 2",
            "broken pipe", "alarm clock", "terminated", "stack fault", "child exited", "continued", "stopped (signal)",
            "stopped", "stopped (tty input)", "stopped (tty output)", "urgent I/O condition", "CPU time limit exceeded",
            "file size limit exceeded", "virtual timer expired", "profiling timer expired", "window changed",
            "I/O possible", "power failure", "bad system call",
        ];
        match NAMES.get(sig as usize) {
            Some(n) if sig > 0 => n.to_string(),
            _ => format!("signal {sig}"),
        }
    }

    pub fn exit_of(st: &ExitStatus) -> (Option<i64>, String) {
        match st.signal() {
            Some(sig) => (None, signal_name(sig)),
            None => (st.code().map(|c| c as i64), String::new()),
        }
    }
}

pub use imp::*;
