import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supervisorDir = path.join(__dirname, '..', 'supervisor-go');
const distDir = path.join(supervisorDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// linux/amd64 is built for a checkout and for CI, but no platform package carries it: the daemon has no
// launcher or tray there either (see platform-binary.ts).
const targets = [
  { GOOS: 'windows', GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor.exe') },
  { GOOS: 'darwin',  GOARCH: 'arm64', out: path.join(distDir, 'orchestrator-supervisor-arm64') },
  { GOOS: 'darwin',  GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor-amd64') },
  { GOOS: 'linux',   GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-supervisor-linux-amd64') },
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
