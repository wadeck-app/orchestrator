// Memory of the Go and the Rust supervisor on Linux and macOS: ONE sample each, informational, never a gate.
//
// Each supervisor runs a child that only sleeps (node, 15 s). After ~5 s the supervisor process ALONE is sampled (not
// its child), then the kill file ends the run and the script checks that the supervisor and the child are gone.
//
// Metrics (KB from the OS, shown in MB). They are NOT the Windows "Private Working Set" of scripts/measure.mjs:
//   RSS            resident set size, from `ps -o rss=`: shared pages (libc, the binary's own text) included.
//   Private (Linux) Private_Clean + Private_Dirty of /proc/<pid>/smaps_rollup: pages mapped by this process alone.
//                  The closest of the three to Windows Private Working Set.
//   Pss (Linux)    proportional set size: private pages + this process's share of the shared ones.
//   footprint (macOS) the line printed by the `footprint` tool when it exists (dirty memory, includes compressed).
//
// usage: node scripts/measure-unix.mjs <go-supervisor> <rust-supervisor>
// exit code: 0 whenever the measurement ran (even if a process was left behind: that is printed as a WARNING),
// 4 on usage, on an unsupported platform or on a missing binary.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const platform = process.platform;
if (platform !== "linux" && platform !== "darwin") {
  console.error(`measure-unix.mjs runs on linux and darwin only (this is ${platform}); use scripts/measure.mjs on Windows.`);
  process.exit(4);
}
const [goArg, rsArg] = process.argv.slice(2);
if (!goArg || !rsArg) {
  console.error("usage: node measure-unix.mjs <go-supervisor> <rust-supervisor>");
  process.exit(4);
}
const candidates = [{ label: "go", exe: path.resolve(goArg) }, { label: "rust", exe: path.resolve(rsArg) }];
for (const c of candidates) {
  if (!fs.existsSync(c.exe)) {
    console.error(`${c.label} supervisor binary not found: ${c.exe}`);
    process.exit(4);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (kb) => (kb / 1024).toFixed(2);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "supmeasure-"));

function psRssKb(pid) {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

function smaps(pid) {
  const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  const kb = (name) => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
    if (!m) throw new Error(`${name} missing from /proc/${pid}/smaps_rollup`);
    return Number(m[1]);
  };
  return { private: kb("Private_Clean") + kb("Private_Dirty"), pss: kb("Pss") };
}

function footprint(pid) {
  let present = true;
  try { execFileSync("sh", ["-c", "command -v footprint"], { stdio: "ignore" }); } catch { present = false; }
  if (!present) return "footprint not available";
  try {
    const out = execFileSync("footprint", [String(pid)], { encoding: "utf8" });
    const line = out.split("\n").find((l) => /footprint/i.test(l) && /\d/.test(l));
    return line ? line.trim() : "footprint ran but printed no footprint line";
  } catch (e) {
    return `footprint failed: ${String(e.message).split("\n")[0]}`;
  }
}

async function measure(c) {
  const dir = path.join(root, c.label);
  fs.mkdirSync(dir, { recursive: true });
  const spec = { command: `node -e "setTimeout(()=>{},15000)"`, logPath: path.join(dir, "run.log") };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const p = spawn(c.exe, [dir], { stdio: "ignore" });
  let exited = false;
  p.on("exit", () => { exited = true; });
  p.on("error", (e) => { console.error(`cannot start ${c.exe}: ${e.message}`); exited = true; });
  await sleep(5000);

  const res = { label: c.label, pid: p.pid, notes: [] };
  let childPid = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
    childPid = st.childPid || 0;
    if (st.state !== "running") res.notes.push(`state is "${st.state}" after 5 s, expected "running"`);
  } catch (e) {
    res.notes.push(`status.json unreadable: ${e.message}`);
  }
  if (exited) {
    res.notes.push("supervisor already exited at sample time: no measure");
  } else {
    try { res.rssKb = psRssKb(p.pid); } catch (e) { res.notes.push(`ps failed: ${e.message.split("\n")[0]}`); }
    if (platform === "linux") {
      try { Object.assign(res, smaps(p.pid)); } catch (e) { res.notes.push(`smaps_rollup: ${e.message}`); }
    } else {
      res.footprint = footprint(p.pid);
    }
  }

  // End the run through the kill file, as the daemon does, then check that nothing is left.
  fs.writeFileSync(path.join(dir, "kill"), "measure-unix\n");
  for (let i = 0; i < 200 && !exited; i++) await sleep(50);
  if (!exited) { res.notes.push("WARNING: supervisor still alive 10 s after the kill file"); p.kill("SIGKILL"); }
  await sleep(300);
  if (childPid && alive(childPid)) res.notes.push(`WARNING: child ${childPid} still alive after the run ended`);
  else if (!childPid) res.notes.push("child pid unknown: child not checked");
  res.cleanup = res.notes.some((n) => n.startsWith("WARNING")) ? "LEFTOVER" : "supervisor and child gone";
  return res;
}

const results = [];
for (const c of candidates) results.push(await measure(c));

const cell = (kb) => (kb === undefined ? "n/a" : `${MB(kb)} MB`);
console.log(`Supervisor process alone, one sample ~5 s after start, ${platform} ${os.arch()}. Informational: not Windows Private Working Set.`);
console.log("RSS = ps rss (shared pages included)" + (platform === "linux"
  ? "; Private = Private_Clean + Private_Dirty and Pss from /proc/<pid>/smaps_rollup"
  : "; footprint = macOS `footprint <pid>` line, when the tool exists"));
const header = platform === "linux" ? ["supervisor", "RSS", "Private", "Pss", "cleanup"] : ["supervisor", "RSS", "footprint", "cleanup"];
const rows = results.map((r) => platform === "linux"
  ? [r.label, cell(r.rssKb), cell(r.private), cell(r.pss), r.cleanup]
  : [r.label, cell(r.rssKb), r.footprint ?? "n/a", r.cleanup]);
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const fmt = (r) => r.map((v, i) => String(v).padEnd(widths[i])).join("  ");
console.log(fmt(header));
for (const r of rows) console.log(fmt(r));
for (const r of results) for (const n of r.notes) console.log(`${r.label}: ${n}`);
