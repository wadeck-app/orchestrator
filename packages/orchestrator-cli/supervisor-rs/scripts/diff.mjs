// Differential test: the same spec.json scenarios run against the Go supervisor and the Rust one, then the status.json
// (schema, key order, formats, values with pids/timestamps normalised), the run log segments, the other files left in
// the run folder, the supervisor's own exit code and stderr are compared.
//
// Runs on Windows, Linux and macOS. The platform differences are all marked with `isWin` / `unixOnly` / `expectSignal`:
//   - the job is run by cmd.exe /d /s /c on Windows and by /bin/sh -c elsewhere (the shell-quoting scenario has one syntax each);
//   - unix status.json carries a `signal` field when the job ended on a signal: the scenarios that end the job
//     (timeout, kill file) must report one, on both supervisors (checked below, not only compared);
//   - unix scenario `group-kill`: the job's grandchild must be gone too (process group kill; taskkill /T on Windows).
// Nothing else is normalised: an OS error text that differs between Go and Rust on unix is reported as a divergence.
//
// usage: node scripts/diff.mjs <go-supervisor> <rust-supervisor> [scenarioNameFilter]
// exit code: 0 all scenarios identical, 1 at least one diverges, 4 usage / missing binary.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";
const [goArg, rsArg, filter] = process.argv.slice(2);
if (!goArg || !rsArg) {
  console.error("usage: node diff.mjs <go-supervisor> <rust-supervisor> [filter]");
  process.exit(4);
}
const goExe = path.resolve(goArg);
const rsExe = path.resolve(rsArg);
for (const [label, exe] of [["Go", goExe], ["Rust", rsExe]]) {
  if (!fs.existsSync(exe)) {
    console.error(`${label} supervisor binary not found: ${exe}. Build it first and pass its path.`);
    process.exit(4);
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "supdiff-"));
const RFC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const js = (src) => (dir) => {
  const f = path.join(dir, "job.js");
  fs.writeFileSync(f, src);
  return `node "${f}"`;
};

// Each scenario: command(dir) -> string, extra spec fields (fn of dir), optional env, optional act(runDir) while it runs,
// optional rawSpec(runDir) to write something else than a JSON spec, optional noSpec.
const scenarios = [
  // sortLog: stdout/stderr interleaving is a race, see shell-quoting.
  { name: "normal-exit-0", sortLog: true, command: js(`console.log("hello"); console.error("oops"); process.exit(0)`) },
  { name: "nonzero-exit-7", command: js(`console.log("x"); process.exit(7)`) },
  { name: "exit-255", command: js(`process.exit(255)`) },
  { name: "exit-minus-1", command: js(`process.exit(-1)`) },
  { name: "timeout", command: js(`console.log("start"); setInterval(()=>{},1000)`), spec: { timeoutSeconds: 1 }, expectSignal: true },
  {
    name: "kill-with-reason",
    command: js(`console.log("start"); setInterval(()=>{},1000)`),
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), "manual\n"); },
    expectSignal: true,
  },
  {
    name: "kill-empty-file",
    command: js(`setInterval(()=>{},1000)`),
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), ""); },
    expectSignal: true,
  },
  {
    name: "kill-and-timeout-both",
    command: js(`setInterval(()=>{},1000)`),
    spec: { timeoutSeconds: 1 },
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), "resource-limit"); },
    expectSignal: true,
  },
  // The job starts a grandchild (same process group) and both wait; the kill file must end the whole group.
  // After the supervisor exited, the grandchild's pid (written by the job) must not answer to signal 0.
  {
    name: "group-kill",
    unixOnly: true,
    command: (dir) => {
      const grandchild = path.join(dir, "grandchild.js");
      fs.writeFileSync(grandchild, `setInterval(()=>{},1000)`);
      return js(`const { spawn } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const g = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });
fs.writeFileSync(path.join(__dirname, "grandchild.pid"), String(g.pid));
setInterval(()=>{},1000)`)(dir);
    },
    act: async (d, jobDir) => {
      await waitRunning(d);
      const pidFile = path.join(jobDir, "grandchild.pid");
      for (let i = 0; i < 500 && !fs.existsSync(pidFile); i++) await sleep(20);
      if (!fs.existsSync(pidFile)) throw new Error("the job never wrote " + pidFile);
      fs.writeFileSync(path.join(d, "kill"), "group-test");
    },
    expectSignal: true,
    // Poll up to ~3 s: an orphan killed by SIGKILL is reaped by init a moment later.
    post: async (r) => {
      const pid = Number(fs.readFileSync(path.join(r.jobDir, "grandchild.pid"), "utf8"));
      for (let i = 0; i < 150; i++) {
        try { process.kill(pid, 0); } catch { return "grandchild gone"; }
        await sleep(20);
      }
      try { process.kill(pid, "SIGKILL"); } catch {}
      return "grandchild STILL ALIVE after the supervisor ended";
    },
  },
  { name: "failed-bad-cwd", command: js(`process.exit(0)`), spec: (d) => ({ cwd: path.join(d, "nope") }) },
  { name: "bad-command-not-found", command: () => "this-command-does-not-exist-xyz --flag" },
  { name: "failed-missing-spec", noSpec: true, command: () => "x" },
  { name: "failed-bad-json", command: () => "x", rawSpec: () => "{not json" },
  { name: "failed-json-array", command: () => "x", rawSpec: () => "[1,2]" },
  { name: "failed-json-null", command: () => "x", rawSpec: () => "null" },
  { name: "failed-empty-spec-file", command: () => "x", rawSpec: () => "" },
  { name: "failed-trailing-data", command: () => "x", rawSpec: (d) => `{"command":"x","logPath":${JSON.stringify(path.join(d, "run.log"))}} trailing` },
  // A valid surrogate pair escape (U+1F600) and a lone one (Go and Rust both decode it to U+FFFD), written as JSON escapes.
  {
    name: "command-surrogate-escapes",
    command: () => "x",
    rawSpec: (d) => `{"command":"echo A\ud83d\ude00B\ud800C","logPath":${JSON.stringify(path.join(d, "run.log"))},"heartbeatMs":50}`,
  },
  // Duplicate keys: the last one wins (here the first command would exit 9).
  {
    name: "duplicate-keys-last-wins",
    command: js(`console.log("second wins")`),
    rawSpec: (d, c) => `{"command":"exit 9","command":${JSON.stringify(c)},"logPath":${JSON.stringify(path.join(d, "run.log"))},"heartbeatMs":50,"heartbeatMs":50}`,
  },
  // Go: time.Duration(seconds) * time.Second wraps in int64 nanoseconds. 2^63-1 s wraps negative and 2^55 s wraps to
  // exactly 0: in both the deadline is already past, so the first poll ends the job. 9223372036 s fits (292 years).
  {
    name: "timeout-wraps-negative",
    command: js(`console.log("start"); setInterval(()=>{},1000)`),
    rawSpec: (d, c) => `{"command":${JSON.stringify(c)},"logPath":${JSON.stringify(path.join(d, "run.log"))},"heartbeatMs":50,"timeoutSeconds":9223372036854775807}`,
    expectSignal: true,
  },
  {
    name: "timeout-wraps-to-zero",
    command: js(`console.log("start"); setInterval(()=>{},1000)`),
    rawSpec: (d, c) => `{"command":${JSON.stringify(c)},"logPath":${JSON.stringify(path.join(d, "run.log"))},"heartbeatMs":50,"timeoutSeconds":36028797018963968}`,
    expectSignal: true,
  },
  { name: "timeout-huge-not-wrapping", command: js(`console.log("quick")`), spec: { timeoutSeconds: 9223372036 } },
  { name: "failed-wrong-type", command: () => "x", rawSpec: (d) => JSON.stringify({ command: 5, logPath: path.join(d, "run.log") }) },
  { name: "failed-wrong-type-int", command: () => "x", rawSpec: (d) => JSON.stringify({ command: "x", logPath: path.join(d, "run.log"), timeoutSeconds: "3" }) },
  { name: "failed-float-int", command: () => "x", rawSpec: (d) => `{"command":"x","logPath":${JSON.stringify(path.join(d, "run.log"))},"heartbeatMs":1.5}` },
  { name: "failed-no-command", command: () => "", rawSpec: (d) => JSON.stringify({ logPath: path.join(d, "run.log") }) },
  { name: "failed-neg-maxBytes", command: js(`0`), spec: (d) => ({ logRotation: { maxBytes: -5, keepSegments: 3 } }) },
  { name: "failed-keep-0", command: js(`0`), spec: (d) => ({ logRotation: { maxBytes: 100, keepSegments: 0 } }) },
  { name: "failed-log-dir-missing", command: js(`0`), spec: (d) => ({ logPath: path.join(d, "no-such-dir", "run.log") }) },
  { name: "case-insensitive-keys", command: js(`console.log("ci")`), rawSpec: (d, c) => JSON.stringify({ COMMAND: c, LogPath: path.join(d, "run.log"), HEARTBEATMS: 50 }) },
  { name: "context-block-and-unknown", command: js(`console.log("ctx")`), spec: { context: { jobId: "j", label: "l", trigger: "cron", retryAttempt: 2, dryRun: true }, whatever: [1, { a: null }] } },
  {
    name: "rotation-large-output",
    command: js(`for (let i = 0; i < 200; i++) console.log("row " + String(i).padStart(3, "0") + " " + "p".repeat(40));`),
    spec: { logRotation: { maxBytes: 1000, keepSegments: 3 } },
    sortLog: true,
  },
  {
    name: "rotation-mb-marker",
    command: js(`for (let i = 0; i < 30; i++) console.log("row " + i + " " + "q".repeat(200));`),
    spec: { logRotation: { maxBytes: 1048576, keepSegments: 1 } },
  },
  {
    name: "rotation-keep-1-small",
    command: js(`for (let i = 0; i < 60; i++) console.log("r" + i);`),
    spec: { logRotation: { maxBytes: 200, keepSegments: 1 } },
  },
  {
    name: "ansi-output",
    command: js(`const E = String.fromCharCode(27), B = String.fromCharCode(7), ST = E + String.fromCharCode(92);
console.log(E + '[31mred' + E + '[0m ' + E + ']0;title' + B + E + ']8;;http://x.test' + ST + 'link' + E + ']8;;' + ST + ' ' + E + '[2K' + E + '[1Gdone');
console.log(E + '[2K');
console.error(E + '[33mwarn' + E + '[39m on stderr');
console.log(E + ']0;never ended');
console.log("a" + E);
console.log(E + "c" + "A" + E + "7B");
process.stdout.write('10%\\r20%\\r100%\\n');`),
    sortLog: true,
  },
  {
    name: "odd-output-bytes",
    command: js(`process.stdout.write(Buffer.from([0xff, 0x41, 0xc3, 0xa9, 0x20, 0x20, 0x0a, 0x0a, 0x0a]));
process.stdout.write("partial no newline");`),
  },
  { name: "env-passthrough", env: { SUP_DIFF_VAR: "value with spaces & <special>" }, command: js(`console.log("VAR=" + process.env.SUP_DIFF_VAR)`) },
  { name: "stdin-is-closed", command: js(`process.stdin.on("data", d => console.log("got data")); process.stdin.on("end", () => console.log("stdin ended")); process.stdin.resume();`) },
  { name: "cwd-is-applied", command: js(`console.log("CWD=" + process.cwd())`), spec: (d) => ({ cwd: os.tmpdir() }) },
  // cmd.exe escapes with ^, sh with \ : the same three words and the same redirection on each shell.
  // stdout and stderr are two pipes read by two threads in each supervisor: the order of two lines written one on each
  // is a race in Go as well as in Rust (seen once on Windows, go: stderr first), hence sortLog on the scenarios that use both.
  { name: "shell-quoting", sortLog: true, command: () => (isWin ? `echo hello "a & b" ^& c && echo second 1>&2` : `echo hello "a & b" \\& c && echo second 1>&2`) },
  { name: "partial-heartbeat-default", command: js(`setTimeout(()=>{}, 300)`), spec: { heartbeatMs: 0 } },
];

async function waitRunning(d) {
  for (let i = 0; i < 500; i++) {
    try { if (fs.readFileSync(path.join(d, "status.json"), "utf8").includes('"running"')) return; } catch {}
    await sleep(20);
  }
  throw new Error("never running in " + d);
}

function runOne(exe, label, sc) {
  const dir = path.join(root, sc.name, label);
  const jobDir = path.join(root, sc.name, label + "-job");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(jobDir, { recursive: true });
  const command = sc.command(jobDir);
  if (!sc.noSpec) {
    if (sc.rawSpec) fs.writeFileSync(path.join(dir, "spec.json"), sc.rawSpec(dir, command));
    else {
      const extra = typeof sc.spec === "function" ? sc.spec(dir) : sc.spec || {};
      const spec = { command, logPath: path.join(dir, "run.log"), heartbeatMs: 50, ...extra };
      fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
    }
  }
  return new Promise(async (resolve) => {
    const t0 = Date.now();
    const p = spawn(exe, [dir], { env: { ...process.env, ...(sc.env || {}) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const watchdog = setTimeout(() => p.kill(), 60000);
    p.on("exit", (code) => { clearTimeout(watchdog); resolve({ dir, jobDir, code, out, err, ms: Date.now() - t0 }); });
    if (sc.act) sc.act(dir, jobDir).catch((e) => console.error("act failed", e.message));
  });
}

const normPath = (s, r) => s.split(r.dir.replaceAll("\\", "\\\\")).join("<RUN>").split(r.jobDir.replaceAll("\\", "\\\\")).join("<JOB>").split(r.dir).join("<RUN>").split(r.dir.replaceAll("\\", "/")).join("<RUN>").split(r.jobDir).join("<JOB>").split(os.tmpdir()).join("<TMP>");

function normalizeStatus(r) {
  let raw;
  try { raw = fs.readFileSync(path.join(r.dir, "status.json"), "utf8"); } catch { return { missing: true }; }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { notJson: raw }; }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "supervisorPid" || k === "childPid")) out[k] = Number.isInteger(v) && v > 0 ? "<pid>" : v;
    else if (/At$/.test(k) || k === "finishedAt") out[k] = typeof v === "string" && RFC.test(v) ? "<RFC3339>" : v;
    else if (typeof v === "string") out[k] = normPath(v, r).replace(/\d{5,}/g, "<n>");
    else out[k] = v;
  }
  return { keyOrder: Object.keys(obj).join(","), obj: out, hasTrailingNewline: raw.endsWith("\n"), compact: !/\n|: /.test(raw) };
}

function normalizeLog(r, sc) {
  const files = fs.readdirSync(r.dir).filter((n) => n.startsWith("run.log")).sort();
  const res = {};
  for (const f of files) {
    const text = fs.readFileSync(path.join(r.dir, f));
    // Keep the bytes visible: latin1 maps each byte to one char, JSON.stringify shows control chars.
    let lines = text.toString("latin1").replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /gm, "[TS] ").split("\n");
    if (sc.sortLog) lines = lines.sort();
    res[f] = lines;
  }
  return res;
}

function otherFiles(r) {
  return fs.readdirSync(r.dir).filter((n) => !n.startsWith("run.log")).map((n) => n.replace(/\d+/g, "<n>")).sort();
}

// Unix only: Go creates status.json, the heartbeat and every log segment with 0o644 (before the umask, equal for both
// supervisors: they run with the umask of this process). Windows has no comparable mode bits.
function fileModes(r) {
  if (isWin) return "n/a on Windows";
  const out = {};
  for (const n of fs.readdirSync(r.dir).filter((n) => n === "status.json" || n === "heartbeat" || n.startsWith("run.log")).sort()) {
    out[n] = (fs.statSync(path.join(r.dir, n)).mode & 0o777).toString(8);
  }
  return out;
}

function heartbeatShape(r) {
  try { const t = fs.readFileSync(path.join(r.dir, "heartbeat"), "utf8"); return /^\d+$/.test(t) ? "integer" : "other:" + JSON.stringify(t); } catch { return "absent"; }
}

let diffs = 0;
const rows = [];
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  if (sc.unixOnly && isWin) continue;
  const go = await runOne(goExe, "go", sc);
  const rs = await runOne(rsExe, "rs", sc);
  const a = {
    exit: go.code, status: normalizeStatus(go), log: normalizeLog(go, sc), files: otherFiles(go), hb: heartbeatShape(go), modes: fileModes(go),
    stdout: go.out, stderr: normPath(go.err, go).replace(/\d{5,}/g, "<n>"),
  };
  const b = {
    exit: rs.code, status: normalizeStatus(rs), log: normalizeLog(rs, sc), files: otherFiles(rs), hb: heartbeatShape(rs), modes: fileModes(rs),
    stdout: rs.out, stderr: normPath(rs.err, rs).replace(/\d{5,}/g, "<n>"),
  };
  if (sc.post) { a.post = await sc.post(go); b.post = await sc.post(rs); }
  const parts = [];
  for (const k of Object.keys(a)) {
    const sa = JSON.stringify(a[k], null, 1), sb = JSON.stringify(b[k], null, 1);
    if (sa !== sb) parts.push(`  [${k}]\n    go: ${JSON.stringify(a[k])}\n    rs: ${JSON.stringify(b[k])}`);
  }
  // Equal is not enough: both could silently miss the signal. On unix a job ended by SIGTERM (or SIGKILL after the
  // grace period) must say so in status.json (Go: syscall.Signal.String(), "terminated" / "killed" on Linux and macOS).
  // Windows has no signal field.
  if (sc.expectSignal && !isWin) {
    for (const [who, n] of [["go", a], ["rs", b]]) {
      const sig = n.status.obj?.signal;
      if (sig !== "terminated" && sig !== "killed") parts.push(`  [signal]\n    ${who}: expected "terminated" or "killed" in status.json, got ${JSON.stringify(sig)}`);
    }
  }
  if (sc.post) for (const [who, n] of [["go", a], ["rs", b]]) if (n.post !== "grandchild gone") parts.push(`  [post]\n    ${who}: ${n.post}`);
  if (parts.length) { diffs++; rows.push(`DIFF ${sc.name} (go ${go.ms}ms, rs ${rs.ms}ms)\n${parts.join("\n")}`); }
  else rows.push(`same ${sc.name} (go ${go.ms}ms, rs ${rs.ms}ms; exit ${go.code}, state ${a.status.obj?.state})`);
}
console.log(rows.join("\n"));
console.log(`\n${diffs} scenario(s) with differences (${rows.length} run on ${process.platform}). Work dir: ${root}`);
process.exit(diffs ? 1 : 0);
