#!/usr/bin/env node
// Copies orch-app/dist into:
//   - orch-server/public            (for `npm run dev` in orch-server)
//   - orchestrator-cli/server/public (bundled into the package by CI)
// Cleans each destination first to avoid stale asset hashes being mixed in.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env['CI']) {
  console.error('[copy-app] ERROR: This script must only run in CI. Do NOT execute it locally or from an agent — use the CI/CD pipeline (commit + push) to deploy.');
  process.exit(1);
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(__dirname, '../../orch-app/dist');

const destinations = [
  { label: 'orch-server/public',            path: resolve(__dirname, '../public') },
  { label: 'orchestrator-cli/server/public', path: resolve(__dirname, '../../orchestrator-cli/server/public') },
];

if (!existsSync(src)) {
  console.error(`orch-app dist not found at ${src}. Run "npm run build --workspace=packages/orch-app" first.`);
  process.exit(1);
}

for (const dest of destinations) {
  if (existsSync(dest.path)) rmSync(dest.path, { recursive: true });
  cpSync(src, dest.path, { recursive: true });
  console.log(`Copied orch-app/dist -> ${dest.label} (${dest.path})`);
}
