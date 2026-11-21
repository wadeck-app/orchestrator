// Reproducibility check of the Rust supervisor, informational: always exits 0, the verdict is in the output.
//
// The publish plan reuses a platform package only when its binary bytes are identical (see rust-toolchain.toml), so the
// same sources must give the same binary wherever they are checked out. This builds supervisor-rs twice, from two
// copies placed in directories with different names, in release profile, with --locked and the pinned toolchain
// (rust-toolchain.toml travels with the copy), and compares sha256:
//   1. WITH   RUSTFLAGS="--remap-path-prefix=<copy dir>=/build [--remap-path-prefix=<CARGO_HOME>=/cargo]"  (what a release would use)
//   2. WITHOUT any remap flag: shows whether the checkout path leaks into the binary.
// For each binary it also searches the bytes for the name of the copy directory (leak) and, when it is an MSVC
// build, for the .pdb path the linker embeds.
//
// usage: node scripts/repro-check.mjs [path-to-cargo]     (default: `cargo` from PATH, or $CARGO)
// Needs the pinned toolchain to be installed already (rustup toolchain install ... as in the workflow).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cargo = process.argv[2] || process.env.CARGO || "cargo";
const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const binName = "orchestrator-supervisor" + (isWin ? ".exe" : "");
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
const out = [];
const say = (s) => { console.log(s); out.push(s); };

// Copies the sources only: target dirs are build output and would make the two builds start from different states.
function copySources(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src"]) {
    const from = path.join(srcRoot, name);
    if (!fs.existsSync(from)) throw new Error(`${from} is missing: cannot build a copy without it`);
    fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
}

function build(dir, rustflags) {
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  if (rustflags) env.RUSTFLAGS = rustflags;
  const r = spawnSync(cargo, ["build", "--release", "--locked"], { cwd: dir, env, encoding: "utf8" });
  if (r.error) throw new Error(`cannot run ${cargo}: ${r.error.message}. Pass the cargo path as first argument.`);
  if (r.status !== 0) throw new Error(`cargo build failed in ${dir} (RUSTFLAGS=${JSON.stringify(rustflags)}):\n${r.stdout}\n${r.stderr}`);
  const bin = path.join(dir, "target", "release", binName);
  return fs.readFileSync(bin);
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Printable ASCII runs of at least 4 chars around a needle, to show what exactly was found.
function context(buf, needle) {
  const found = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(needle, from);
    if (i < 0 || found.length >= 2) break;
    let s = i, e = i + needle.length;
    while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f && i - s < 160) s--;
    while (e < buf.length && buf[e] >= 0x20 && buf[e] < 0x7f && e - i < 160) e++;
    found.push(buf.subarray(s, e).toString("latin1"));
    from = e;
  }
  return found;
}

function diffBytes(a, b) {
  if (a.length !== b.length) return `sizes differ (${a.length} vs ${b.length} bytes)`;
  let n = 0;
  const first = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; if (first.length < 8) first.push("0x" + i.toString(16)); }
  return n === 0 ? "none" : `${n} byte(s) differ, first offsets ${first.join(" ")}`;
}

function variant(label, dirs, rustflagsFor) {
  const bins = dirs.map((d) => build(d, rustflagsFor(d)));
  const [h1, h2] = bins.map(sha);
  say(`--- ${label}`);
  bins.forEach((b, i) => {
    say(`  sha256 ${path.basename(dirs[i])}: ${h1 && i === 0 ? h1 : h2}  (${b.length} bytes)`);
    const own = path.basename(dirs[i]);
    const leaks = context(b, Buffer.from(own));
    say(`  path leak (${own} found in the binary): ${leaks.length ? "YES -> " + leaks.map((l) => JSON.stringify(l)).join(" | ") : "no"}`);
    if (isWin) {
      const pdb = context(b, Buffer.from(".pdb"));
      say(`  .pdb path in the binary: ${pdb.length ? pdb.map((l) => JSON.stringify(l)).join(" | ") : "none"}`);
    }
  });
  const same = h1 === h2;
  if (!same) say(`  differing bytes: ${diffBytes(bins[0], bins[1])}`);
  say(`VERDICT ${label}: ${same ? "IDENTICAL" : "DIFFERENT"}`);
  return same;
}

try {
  // realpath: on Windows runners the temp dir is often an 8.3 short name; the remap flag must name the path the compiler sees.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "repro-")));
  const dirs = [path.join(base, "checkout-alpha"), path.join(base, "wd-b-longer-name")];
  dirs.forEach(copySources);
  say(`copies: ${dirs.join(" , ")}  (left in place, nothing is deleted)`);
  say(`cargo: ${cargo}; CARGO_HOME: ${cargoHome}; platform: ${process.platform} ${os.arch()}`);
  const v = spawnSync(cargo, ["--version"], { cwd: dirs[0], encoding: "utf8" });
  say(`toolchain seen from the copy (pinned by rust-toolchain.toml): ${(v.stdout || v.stderr || "unknown").trim()}`);

  const remap = (d) => {
    const flags = [`--remap-path-prefix=${d}=/build`];
    if (fs.existsSync(cargoHome)) flags.push(`--remap-path-prefix=${cargoHome}=/cargo`);
    return flags.join(" ");
  };
  const withRemap = variant("with-remap", dirs, remap);
  const without = variant("without-remap", dirs, () => undefined);
  // MSVC only: the linker stamps the PE header and the debug directory with the link time and a random PDB GUID unless
  // told to be deterministic (/Brepro). Seen on a Windows build where only those fields differed.
  const msvc = isWin && /host:.*msvc/.test(spawnSync(cargo, ["-vV"], { cwd: dirs[0], encoding: "utf8" }).stdout || "");
  const brepro = msvc ? variant("with-remap+Brepro", dirs, (d) => remap(d) + " -C link-arg=/Brepro") : undefined;
  say("");
  say(`SUMMARY reproducible with remap: ${withRemap ? "yes" : "NO"}; reproducible without remap: ${without ? "yes" : "no"}` +
    (msvc ? `; with remap + /Brepro: ${brepro ? "yes" : "NO"}` : ""));
  say("Unverified assumptions: RUSTFLAGS with spaces in a path would be split by cargo (the temp paths here have none); " +
    "remapping does not cover paths the linker or the C runtime embed on its own.");
} catch (e) {
  say(`VERDICT could not run: ${e.message}`);
}
process.exit(0);
