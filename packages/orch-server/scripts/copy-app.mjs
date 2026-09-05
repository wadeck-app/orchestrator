#!/usr/bin/env node
// Copies orch-app/dist into:
//   - orch-server/public            (for `npm run dev` in orch-server)
//   - orchestrator-cli/server/public (for local monorepo testing)
//   - global npm install/server/public (for the running production daemon)
// Cleans each destination first to avoid stale asset hashes being mixed in.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(__dirname, '../../orch-app/dist');

const destinations = [
  { label: 'orch-server/public',            path: resolve(__dirname, '../public') },
  { label: 'orchestrator-cli/server/public', path: resolve(__dirname, '../../orchestrator-cli/server/public') },
];

// Also copy to globally installed package via npm root -g
try {
  const globalRoots = [
    execSync('npm root -g', { encoding: 'utf8' }).trim(),
  ];
  // nvm puts packages in a different path than npm root -g
  // Try to find via the running server process or common nvm paths
  const nvmHome = process.env['NVM_HOME'] || resolve(process.env['APPDATA'] || '', '../Local/nvm');
  const nvmMatch = execSync('node --version', { encoding: 'utf8' }).trim();
  const nvmPath = resolve(nvmHome || '', `${nvmMatch}/node_modules`);
  if (existsSync(nvmPath)) globalRoots.push(nvmPath);

  for (const globalRoot of globalRoots) {
    const globalServerPublic = resolve(globalRoot, '@wadeck-app/orchestrator-cli/server/public');
    if (existsSync(globalServerPublic) && !destinations.some(d => d.path === globalServerPublic)) {
      destinations.push({ label: `global orchestrator-cli/server/public (${globalRoot})`, path: globalServerPublic });
    }
  }
} catch { /* skip */ }

if (!existsSync(src)) {
  console.error(`orch-app dist not found at ${src}. Run "npm run build --workspace=packages/orch-app" first.`);
  process.exit(1);
}

for (const dest of destinations) {
  if (existsSync(dest.path)) rmSync(dest.path, { recursive: true });
  cpSync(src, dest.path, { recursive: true });
  console.log(`Copied orch-app/dist -> ${dest.label} (${dest.path})`);
}
