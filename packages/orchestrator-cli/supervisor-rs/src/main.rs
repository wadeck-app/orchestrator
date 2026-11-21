mod ansi;
mod json;
mod proc;
mod run;
mod runlog;
mod timefmt;

#[cfg(test)]
mod tests_rotation;
#[cfg(test)]
mod tests_run;

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.len() != 2 {
        eprintln!("usage: orchestrator-supervisor <run folder>\nThe run folder holds spec.json, written by the orchestrator daemon.");
        std::process::exit(2);
    }
    let Some(run_dir) = args[1].to_str() else {
        eprintln!("orchestrator-supervisor: the run folder path is not valid Unicode: {:?}", args[1]);
        std::process::exit(2);
    };
    std::process::exit(run::run(run_dir));
}
