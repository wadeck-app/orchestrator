// Built by `app-core-cli package` into dist-module/dsl-lib/entries.mjs. The default export lists the components
// the shell registers as "orchestrator:<name>" (so the views say `$type: orchestrator:JobCardGrid`).
// The components themselves live in @wadeck-app/orch-dsl-lib; this only tells them where the module is mounted.
import { createOrchLibEntries } from '@wadeck-app/orch-dsl-lib';
import { API_BASE, ROUTE_BASE } from '../commons/moduleConfig.js';

// The module's own API and pages live under app-core's prefixes, not at the root.
export default createOrchLibEntries({ apiBase: API_BASE, routeBase: ROUTE_BASE });
