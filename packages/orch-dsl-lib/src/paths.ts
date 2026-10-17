import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where things are. Kept apart from scripts/build.ts because that file imports esbuild, which cannot
 * even be loaded inside the jsdom environment the rendering tests run in.
 */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGES_DIR = path.resolve(PACKAGE_DIR, '..');
export const MODULE_DIR = path.join(PACKAGES_DIR, 'app-module-orchestrator');
export const ORCH_UI_SRC = path.join(PACKAGES_DIR, 'orch-ui', 'src');
export const ORCH_APP_ENTRIES = path.join(PACKAGES_DIR, 'orch-app', 'src', 'generated', 'entries.tsx');
export const ORCH_APP_CSS = path.join(PACKAGES_DIR, 'orch-app', 'src', 'index.css');
export const DEFAULT_OUT_DIR = path.join(MODULE_DIR, 'dsl-lib');
