import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supervisorDir = path.join(__dirname, '..', 'supervisor-go');
const distDir = path.join(supervisorDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// One entry per platform of PLATFORM_TARGETS (platform-binary.ts); test/platform-targets.test.js checks the names.
const targets = [
  { GOOS: 'windows', GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor.exe') },
  { GOOS: 'darwin',  GOARCH: 'arm64', out: path.join(distDir, 'orchestrator-supervisor-arm64') },
  { GOOS: 'darwin',  GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor-amd64') },
  { GOOS: 'linux',   GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor-linux-amd64') },
  { GOOS: 'linux',   GOARCH: 'arm64', out: path.join(distDir, 'orchestrator-supervisor-linux-arm64') },
];

for (const { GOOS, GOARCH, out } of targets) {
  process.stdout.write(`Building ${GOOS}/${GOARCH} -> ${path.basename(out)} ... `);
  execSync(
    // Reproducible output, for the same reason as the tray: the publish step only republishes a platform
    // package when a binary hash changes, so identical sources must give an identical binary.
    `go build -trimpath -buildvcs=false -ldflags "-s -w" -o "${out}" .`,
    { cwd: supervisorDir, env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
  console.log('ok');
}
console.log('build-supervisor done');
