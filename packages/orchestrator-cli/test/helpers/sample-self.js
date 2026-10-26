'use strict';

// Run by no-deprecations.test.js with --throw-deprecation: samples this very process the way the resource monitor does.
require('pidusage')(process.pid).then(
  () => { process.exit(0); },
  (err) => { process.stderr.write(`sampling failed: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); },
);
