// Differential test: the same spec.json scenarios run against the Go supervisor and the Rust one, then the status.json
// (schema, key order, formats, values with pids/timestamps normalised), the run log segments, the other files left in
// the run folder, the supervisor's own exit code and stderr are compared.
//
// usage: node scripts/diff.mjs <go.exe> <rust.exe> [scenarioNameFilter]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [goExe, rsExe, filter] = process.argv.slice(2);
if (!goExe || !rsExe) {
  console.error("usage: node diff.mjs <go.exe> <rust.exe> [filter]");
  process.exit(4);
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
  { name: "normal-exit-0", command: js(`console.log("hello"); console.error("oops"); process.exit(0)`) },
  { name: "nonzero-exit-7", command: js(`console.log("x"); process.exit(7)`) },
  { name: "exit-255", command: js(`process.exit(255)`) },
  { name: "exit-minus-1", command: js(`process.exit(-1)`) },
  { name: "timeout", command: js(`console.log("start"); setInterval(()=>{},1000)`), spec: { timeoutSeconds: 1 } },
  {
    name: "kill-with-reason",
    command: js(`console.log("start"); setInterval(()=>{},1000)`),
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), "manual\n"); },
  },
  {
    name: "kill-empty-file",
    command: js(`setInterval(()=>{},1000)`),
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), ""); },
  },
  {
    name: "kill-and-timeout-both",
    command: js(`setInterval(()=>{},1000)`),
    spec: { timeoutSeconds: 1 },
    act: async (d) => { await waitRunning(d); fs.writeFileSync(path.join(d, "kill"), "resource-limit"); },
  },
  { name: "failed-bad-cwd", command: js(`process.exit(0)`), spec: (d) => ({ cwd: path.join(d, "nope") }) },
  { name: "bad-command-not-found", command: () => "this-command-does-not-exist-xyz --flag" },
  { name: "failed-missing-spec", noSpec: true, command: () => "x" },
  { name: "failed-bad-json", command: () => "x", rawSpec: () => "{not json" },
  { name: "failed-json-array", command: () => "x", rawSpec: () => "[1,2]" },
  { name: "failed-json-null", command: () => "x", rawSpec: () => "null" },
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
  { name: "shell-quoting", command: () => `echo hello "a & b" ^& c && echo second 1>&2` },
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
    if (sc.act) sc.act(dir).catch((e) => console.error("act failed", e.message));
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

function heartbeatShape(r) {
  try { const t = fs.readFileSync(path.join(r.dir, "heartbeat"), "utf8"); return /^\d+$/.test(t) ? "integer" : "other:" + JSON.stringify(t); } catch { return "absent"; }
}

let diffs = 0;
const rows = [];
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  const go = await runOne(goExe, "go", sc);
  const rs = await runOne(rsExe, "rs", sc);
  const a = {
    exit: go.code, status: normalizeStatus(go), log: normalizeLog(go, sc), files: otherFiles(go), hb: heartbeatShape(go),
    stdout: go.out, stderr: normPath(go.err, go).replace(/\d{5,}/g, "<n>"),
  };
  const b = {
    exit: rs.code, status: normalizeStatus(rs), log: normalizeLog(rs, sc), files: otherFiles(rs), hb: heartbeatShape(rs),
    stdout: rs.out, stderr: normPath(rs.err, rs).replace(/\d{5,}/g, "<n>"),
  };
  const parts = [];
  for (const k of Object.keys(a)) {
    const sa = JSON.stringify(a[k], null, 1), sb = JSON.stringify(b[k], null, 1);
    if (sa !== sb) parts.push(`  [${k}]\n    go: ${JSON.stringify(a[k])}\n    rs: ${JSON.stringify(b[k])}`);
  }
  if (parts.length) { diffs++; rows.push(`DIFF ${sc.name} (go ${go.ms}ms, rs ${rs.ms}ms)\n${parts.join("\n")}`); }
  else rows.push(`same ${sc.name} (go ${go.ms}ms, rs ${rs.ms}ms; exit ${go.code}, state ${a.status.obj?.state})`);
}
console.log(rows.join("\n"));
console.log(`\n${diffs} scenario(s) with differences. Work dir: ${root}`);
process.exit(diffs ? 1 : 0);
