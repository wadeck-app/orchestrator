#!/usr/bin/env node
// Copies orch-app/dist into orch-server/public after both are built
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(__dirname, '../../orch-app/dist');
const dest = resolve(__dirname, '../public');

if (!existsSync(src)) {
  console.error(`orch-app dist not found at ${src}. Run "npm run build --workspace=packages/orch-app" first.`);
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied orch-app/dist -> orch-server/public (${dest})`);
