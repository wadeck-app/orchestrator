import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '../..');
const CI_DIR    = path.join(__dirname, '..');
const CONFIG    = path.join(CI_DIR, 'launcher.config.json');
const OUT_DIR   = path.join(ROOT, 'launcher-go', 'dist');
const TMPL      = path.join(ROOT, 'launcher-go', 'main.go.tmpl');
// Use createRequire so Node's module resolution handles workspace-hoisted node_modules correctly
const require   = createRequire(import.meta.url);
const BUILD_SH  = path.join(
  path.dirname(require.resolve('@wadeck-app/singleton-daemon-kit/package.json')),
  'go-launcher', 'build.sh'
);

if (!fs.existsSync(BUILD_SH)) {
  console.error(`build.sh not found at ${BUILD_SH} — run 'npm install' first`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const toUnix = p => p.replace(/\\/g, '/');
console.log('Building orchestrator launcher via SDK build.sh...');
execFileSync('bash', [toUnix(BUILD_SH), toUnix(CONFIG), toUnix(OUT_DIR), toUnix(TMPL)], { stdio: 'inherit', windowsHide: true });
console.log('Launcher binaries built successfully.');
