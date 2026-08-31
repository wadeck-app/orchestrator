import * as path from 'node:path';
import * as fs from 'node:fs';

// Finds packages/orch-server/dist/index.js relative to this compiled package.
// From packages/orchestrator-cli/dist/ -> ../../orch-server/dist/index.js
export function findOrchServerBinary(): string {
  const candidate = path.resolve(__dirname, '..', '..', 'orch-server', 'dist', 'index.js');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `orch-server binary not found at ${candidate}. Run "npm run build --workspace=packages/orch-server" first.`,
    );
  }
  return candidate;
}
