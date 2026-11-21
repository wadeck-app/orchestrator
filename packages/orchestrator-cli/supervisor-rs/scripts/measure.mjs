// Memory/latency measurement of ONE supervisor process at a time, sequential, light load.
//   Private Working Set / Working Set / Private Bytes from Win32_PerfFormattedData_PerfProc_Process of the supervisor
//   process alone, sampled ~1.6 s and ~12 s after it was started, plus the time to the first heartbeat.
//   idle:   child = node, setTimeout 40 s
//   active: child = node printing one 150-byte line every 100 ms for 14 s, with logRotation maxBytes 4096 keepSegments 3
//
// usage: node scripts/measure.mjs <reps> <label=exe> [<label=exe> ...]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE = "C:/App/nodejs/node.exe";
const reps = Number(process.argv[2]);
const candidates = process.argv.slice(3).map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), exe: a.slice(i + 1) }; });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "supmeasure-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => +(n / 1048576).toFixed(2);

function sample(pid) {
  const ps = `$p=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=${pid}"; "$($p.WorkingSetPrivate) $($p.WorkingSet) $($p.PrivateBytes) $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim().split(" ").map(Number);
  if (out.length !== 4 || out.some((x) => !Number.isFinite(x))) throw new Error("bad sample for pid " + pid + ": " + out);
  return { privateWS: MB(out[0]), ws: MB(out[1]), privateBytes: MB(out[2]), at: out[3] };
}

function tasklistHas(pid) {
  return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).includes(String(pid));
}

async function once(c, mode, rep) {
  const dir = path.join(root, `${c.label}-${mode}-${rep}`);
  fs.mkdirSync(dir, { recursive: true });
  const job = path.join(dir, "job.js");
  fs.writeFileSync(job, mode === "idle"
    ? "setTimeout(()=>{},40000)"
    : "const t=setInterval(()=>console.log('line '+Date.now()+' '+'x'.repeat(130)),100); setTimeout(()=>clearInterval(t),14000)");
  const spec = { command: `"${NODE}" "${job}"`, logPath: path.join(dir, "run.log") };
  if (mode === "active") spec.logRotation = { maxBytes: 4096, keepSegments: 3 };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const t0 = Date.now();
  const p = spawn(c.exe, [dir], { windowsHide: true, stdio: "ignore" });
  const pid = p.pid;
  let exited = false;
  p.on("exit", () => (exited = true));
  let hb = null;
  while (hb === null && Date.now() - t0 < 5000) {
    if (fs.existsSync(path.join(dir, "heartbeat"))) hb = Date.now() - t0;
    else await sleep(1);
  }
  await sleep(Math.max(0, 1100 - (Date.now() - t0)));
  const s1 = sample(pid);
  await sleep(Math.max(0, 11500 - (Date.now() - t0)));
  const s2 = sample(pid);
  let childPid = null;
  try { childPid = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).childPid; } catch {}
  const rotated = fs.readdirSync(dir).filter((n) => n.startsWith("run.log")).sort();
  fs.writeFileSync(path.join(dir, "kill"), "measure");
  for (let i = 0; i < 300 && !exited; i++) await sleep(50);
  await sleep(300);
  const leftover = [pid, childPid].filter((x) => x && tasklistHas(x));
  return {
    label: c.label, mode, rep, pid, firstHeartbeatMs: hb,
    s1: { ...s1, atMs: s1.at - t0 }, s2: { ...s2, atMs: s2.at - t0 },
    segments: rotated.length > 1 ? rotated.join(",") : undefined, leftover,
  };
}

const results = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const mode of ["idle", "active"]) {
    for (const c of candidates) {
      const r = await once(c, mode, rep);
      results.push(r);
      console.log(JSON.stringify(r));
      if (r.leftover.length) { console.error("LEFTOVER PROCESSES", r.leftover); process.exit(3); }
    }
  }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 1));
console.log("results in " + root);
