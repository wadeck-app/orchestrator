import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const trayDir = path.join(__dirname, '..', 'tray-go');
const distDir = path.join(trayDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const targets = [
  { GOOS: 'windows', GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-tray.exe') },
  { GOOS: 'darwin',  GOARCH: 'arm64', out: path.join(distDir, 'orchestrator-tray-arm64') },
  { GOOS: 'darwin',  GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-tray-amd64') },
];

for (const { GOOS, GOARCH, out } of targets) {
  process.stdout.write(`Building ${GOOS}/${GOARCH} -> ${path.basename(out)} ... `);
  execSync(
    // No -X main.version: the tray reports the version it receives from the daemon over IPC.
    // Baking it in would change the binary on every release, which would defeat the
    // binary-hash gate that decides whether a platform package needs republishing.
    `go build -trimpath -ldflags "-s -w" -o "${out}" .`,
    { cwd: trayDir, env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
  console.log('ok');
}
console.log('build-tray done');
