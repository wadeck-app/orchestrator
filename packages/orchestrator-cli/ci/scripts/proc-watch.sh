#!/usr/bin/env bash
# Evidence for the macOS-only `spawn ... EAGAIN` seen during `Run tests` (process table full).
# Nothing here changes how tests run; it only records what the machine looked like.
#
#   proc-watch.sh start   print the limits, then sample the process table every 2s in the background
#   proc-watch.sh dump    print the limits, the samples, and who owns the processes right now
#
# Samples go to $RUNNER_TEMP/proc-watch.log (one line: time, total processes, processes of this user).
set -u

LOG="${RUNNER_TEMP:-/tmp}/proc-watch.log"
PIDFILE="${RUNNER_TEMP:-/tmp}/proc-watch.pid"

limits() {
  echo "--- limits"
  echo "ulimit -u (max user processes): $(ulimit -u)"
  echo "ulimit -n (max open files):     $(ulimit -n)"
  if [ "$(uname)" = "Darwin" ]; then
    echo "kern.maxproc:        $(sysctl -n kern.maxproc)"
    echo "kern.maxprocperuid:  $(sysctl -n kern.maxprocperuid)"
  fi
  echo "cpus: $(getconf _NPROCESSORS_ONLN)"
}

snapshot() {
  echo "$(date +%T) total=$(ps -ax | wc -l | tr -d ' ') mine=$(ps -u "$(id -u)" | wc -l | tr -d ' ')"
}

case "${1:-}" in
  start)
    limits
    : > "$LOG"
    snapshot | tee -a "$LOG"
    (
      while true; do
        sleep 2
        snapshot >> "$LOG"
      done
    ) > /dev/null 2>&1 &
    echo $! > "$PIDFILE"
    echo "proc-watch: sampling every 2s into $LOG (pid $!)"
    ;;
  dump)
    limits
    echo "--- samples (peak first, then the last 15)"
    if [ -f "$LOG" ]; then
      sort -t= -k3 -n -r "$LOG" | head -3
      echo "..."
      tail -15 "$LOG"
    else
      echo "proc-watch: no samples at $LOG, 'start' was never run on this leg"
    fi
    echo "--- processes by command, most numerous first"
    ps -axo comm | sed 's|.*/||' | sort | uniq -c | sort -rn | head -15
    echo "--- node processes still alive (pid, ppid, age, command)"
    ps -axo pid,ppid,etime,command | grep -E '[n]ode ' | cut -c1-200 | head -40
    ;;
  stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
    exit 0
    ;;
  *)
    echo "usage: proc-watch.sh start|dump|stop" >&2
    exit 4
    ;;
esac
