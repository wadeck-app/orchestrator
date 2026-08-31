import * as path from 'node:path';
import * as fs from 'node:fs';

// Finds orch-server/dist/index.js bundled inside this package at server/dist/index.js.
// When installed: node_modules/@wadeck-app/orchestrator-cli/dist/ -> ../server/dist/index.js
// In monorepo dev:  packages/orchestrator-cli/dist/             -> ../server/dist/index.js
export function findOrchServerBinary(): string {
  const candidate = path.resolve(__dirname, '..', 'server', 'dist', 'index.js');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `orch-server not found at ${candidate}. Re-install @wadeck-app/orchestrator-cli or run "npm run build:server" to copy orch-server into the package.`,
    );
  }
  return candidate;
}
