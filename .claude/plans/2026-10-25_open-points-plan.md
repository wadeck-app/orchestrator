# Open points

Only what is still open. When a point is closed, delete it here; when the list is empty, delete this file.

1. **Real Linux host.** Ubuntu x64 start at boot is validated (`orch install` enables lingering as the user, sudo only if refused). Still untested: arm64, other distributions, the sudo path (polkit allowed the user alone), and the systemd unit after an `nvm use` (not checked whether it still pins a bundle path; `orch start` follows `nvm use`, and the login entry is re-registered when it names a path that is gone). A kit change would let the launcher probe `<prefix>/lib/node_modules`.
2. **`orch exec` is never supervised**, by design (plain children of the daemon). `orch stop`, `restart` and `cli update` warn about the running ones. Not done: `orch status` does not list them, so the "wait for them" way out has no command; the tray and dashboard quit confirmations were not checked.
3. **Progress/ETA strategies learn from the head of a rotated run only**: the dropped segments are gone, which is inherent and documented in `docs/daemon-config.md`. No change planned unless a learned strategy must work on runs above 250 MB.
4. **Unexplained ubuntu CI exit 137** (run `40405633462`, `980e4ef`): the test output stops after a normal test, 31 s of silence, then the `strace` wrapper is `Killed`. No assertion failed and the next run on the same code was green. Same family as runs 419 and 421 noted in the workflow. As of 2026-10-26 the CI relay (`queue wait ci`) delivered nothing from this repository and runs were followed through the GitHub API; not re-checked since.
5. **Supervised jobs, not yet verified** (behaviour in `docs/supervised-jobs.md`):
   - the survival spike under the REAL launcher (a tray start kills every tray on the machine, so it is not run on a dev machine), and a real `orch cli update` with a running job under it;
   - a run adopted after an edited or deleted job, a dry run, or a deleted run log (finalize from `spec.json`, no crash);
   - a grandchild outliving the shell, a full disk on `status.json`, sleep/resume;
   - whether the queue's `/push` dedupes an event delivered twice;
   - job survival across a restart on Linux and macOS (macOS CI only; Linux start at boot validated, survival not recorded).
