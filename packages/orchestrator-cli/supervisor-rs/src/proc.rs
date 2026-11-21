// Platform part: how the job is started, how its tree is ended, how its end is reported.
// Both branches are built and tested: the Windows one locally, the unix one (Linux, macOS) by CI (build, unit tests and
// the differential against the Go supervisor). A change to the unix branch cannot be compiled on a Windows machine.

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

    /// Go reports a failed start as "fork/exec /bin/sh: <os error>". Seen in the CI differential (Linux and macOS, a
    /// missing cwd): `fork/exec /bin/sh: no such file or directory`.
    pub fn start_error_prefix() -> String {
        "fork/exec /bin/sh: ".to_string()
    }

    /// SIGTERM to the whole group, SIGKILL once the grace period has passed.
    pub fn end_tree(pid: u32, spec: &Spec) {
        unsafe {
            kill(-(pid as i32), SIGTERM);
        }
        // Go's time.Sleep returns at once for a duration that wrapped to zero or less.
        if let Some(grace) = crate::run::kill_grace(spec.kill_grace_ms) {
            std::thread::sleep(grace);
        }
        unsafe {
            kill(-(pid as i32), SIGKILL);
        }
    }

    // @formatter:off
    // The names of Go's syscall.Signal.String() are the `signals` table of the platform's zerrors file, copied as is.
    // Index 0 is empty (Go has no entry for 0) and so is any number the table does not name: Go then prints "signal N".
    // Shipped unix targets (PLATFORM_TARGETS): linux-x64 and darwin-arm64.

    /// GOROOT/src/syscall/zerrors_linux_amd64.go, `var signals` (Go 1.26.5).
    #[cfg(target_os = "linux")]
    const SIGNALS: [&str; 32] = [
        "", "hangup", "interrupt", "quit", "illegal instruction", "trace/breakpoint trap", "aborted", "bus error",
        "floating point exception", "killed", "user defined signal 1", "segmentation fault", "user defined signal 2",
        "broken pipe", "alarm clock", "terminated", "stack fault", "child exited", "continued", "stopped (signal)",
        "stopped", "stopped (tty input)", "stopped (tty output)", "urgent I/O condition", "CPU time limit exceeded",
        "file size limit exceeded", "virtual timer expired", "profiling timer expired", "window changed",
        "I/O possible", "power failure", "bad system call",
    ];

    /// GOROOT/src/syscall/zerrors_darwin_arm64.go, `var signals` (Go 1.26.5).
    #[cfg(target_os = "macos")]
    const SIGNALS: [&str; 32] = [
        "", "hangup", "interrupt", "quit", "illegal instruction", "trace/BPT trap", "abort trap", "EMT trap",
        "floating point exception", "killed", "bus error", "segmentation fault", "bad system call", "broken pipe",
        "alarm clock", "terminated", "urgent I/O condition", "suspended (signal)", "suspended", "continued",
        "child exited", "stopped (tty input)", "stopped (tty output)", "I/O possible", "cputime limit exceeded",
        "filesize limit exceeded", "virtual timer expired", "profiling timer expired", "window size changes",
        "information request", "user defined signal 1", "user defined signal 2",
    ];
    // @formatter:on

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    compile_error!("no Go signal-name table for this unix: copy the `signals` array of GOROOT/src/syscall/zerrors_<os>_<arch>.go into proc.rs");

    /// Go's Signal.String(): the table entry, or "signal N" for a number outside the table or without a name.
    fn signal_name(sig: i32) -> String {
        match usize::try_from(sig).ok().and_then(|i| SIGNALS.get(i)) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => format!("signal {sig}"),
        }
    }

    pub fn exit_of(st: &ExitStatus) -> (Option<i64>, String) {
        match st.signal() {
            Some(sig) => (None, signal_name(sig)),
            None => (st.code().map(|c| c as i64), String::new()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::signal_name;

        #[cfg(target_os = "linux")]
        #[test]
        fn names_follow_go_zerrors_linux_amd64() {
            assert_eq!(signal_name(1), "hangup");
            assert_eq!(signal_name(7), "bus error");
            assert_eq!(signal_name(9), "killed");
            assert_eq!(signal_name(10), "user defined signal 1");
            assert_eq!(signal_name(12), "user defined signal 2");
            assert_eq!(signal_name(15), "terminated");
            assert_eq!(signal_name(16), "stack fault");
            assert_eq!(signal_name(17), "child exited");
            assert_eq!(signal_name(18), "continued");
            assert_eq!(signal_name(19), "stopped (signal)");
            assert_eq!(signal_name(20), "stopped");
            assert_eq!(signal_name(29), "I/O possible");
            assert_eq!(signal_name(30), "power failure");
            assert_eq!(signal_name(31), "bad system call");
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn names_follow_go_zerrors_darwin_arm64() {
            assert_eq!(signal_name(1), "hangup");
            assert_eq!(signal_name(7), "EMT trap");
            assert_eq!(signal_name(9), "killed");
            assert_eq!(signal_name(10), "bus error");
            assert_eq!(signal_name(12), "bad system call");
            assert_eq!(signal_name(15), "terminated");
            assert_eq!(signal_name(16), "urgent I/O condition");
            assert_eq!(signal_name(17), "suspended (signal)");
            assert_eq!(signal_name(18), "suspended");
            assert_eq!(signal_name(19), "continued");
            assert_eq!(signal_name(20), "child exited");
            assert_eq!(signal_name(29), "information request");
            assert_eq!(signal_name(30), "user defined signal 1");
            assert_eq!(signal_name(31), "user defined signal 2");
        }

        // Go: a number outside the table, or 0 / negative, prints "signal N".
        #[test]
        fn unnamed_numbers_fall_back_to_signal_n() {
            assert_eq!(signal_name(0), "signal 0");
            assert_eq!(signal_name(32), "signal 32");
            assert_eq!(signal_name(64), "signal 64");
            assert_eq!(signal_name(-1), "signal -1");
        }
    }
}

pub use imp::*;
