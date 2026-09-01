import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
const version = pkg.version;

const trayDir = path.join(__dirname, '..', 'tray-go');
const distDir = path.join(trayDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const targets = [
  { GOOS: 'windows', GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-tray.exe') },
  { GOOS: 'darwin',  GOARCH: 'arm64', out: path.join(distDir, 'orchestrator-tray-arm64') },
  { GOOS: 'darwin',  GOARCH: 'amd64', out: path.join(distDir, 'orchestrator-tray-amd64') },
];

for (const { GOOS, GOARCH, out } of targets) {
  process.stdout.write(`Building ${GOOS}/${GOARCH} → ${path.basename(out)} ... `);
  execSync(
    `go build -trimpath -ldflags "-s -w -X main.version=${version}" -o "${out}" .`,
    { cwd: trayDir, env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
  console.log('ok');
}
console.log('build-tray done');
