import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where things are. Kept apart from the scripts because those import build tools (esbuild, postcss) that
 * cannot even be loaded inside the jsdom environment the rendering tests run in.
 */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGES_DIR = path.resolve(PACKAGE_DIR, '..');
export const MODULE_DIR = path.join(PACKAGES_DIR, 'app-module-orchestrator');
export const ORCH_UI_SRC = path.join(PACKAGES_DIR, 'orch-ui', 'src');
export const ORCH_APP_ENTRIES = path.join(PACKAGES_DIR, 'orch-app', 'src', 'generated', 'entries.tsx');
export const ORCH_APP_CSS = path.join(PACKAGES_DIR, 'orch-app', 'src', 'index.css');
/** The module's views: the Tailwind scan reads their classes, derive-pages writes them. */
export const MODULE_VIEWS_DIR = path.join(MODULE_DIR, 'src', 'dsl-views');
/** Where `app-core-cli package` looks for the stylesheet it copies as built. */
export const MODULE_STYLE_CSS = path.join(MODULE_DIR, 'src', 'dsl-components', 'style.css');
/** What `app-core-cli package` writes by default; the daemon's package ships its content as app-module/. */
export const MODULE_DIST = path.join(MODULE_DIR, 'dist-module');
