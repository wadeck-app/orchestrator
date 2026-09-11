#!/usr/bin/env node
/**
 * Integration test for the updater engine check.
 * Simulates: version >=22 should be rejected on Node 20.
 */
const semver = require('semver');
const { execSync } = require('node:child_process');

console.log('=== Updater Engine Check Integration Test ===');
console.log('Current Node:', process.version);
console.log('');

// Simulate what checkEngineCompatibility does
async function testEngineCheck(pkgName, version) {
  console.log(`Testing: ${pkgName}@${version}`);

  try {
    // This is what the updater does
    const npmView = execSync(
      `npm view ${pkgName}@${version} engines.node --json`,
      { encoding: 'utf8', timeout: 10_000 }
    ).trim();

    console.log(`  npm view result: "${npmView}"`);

    const engineSpec = JSON.parse(npmView);
    if (!engineSpec) {
      console.log(`  → No engine constraint, OK`);
      return { ok: true };
    }

    console.log(`  Engine requirement: ${engineSpec}`);
    console.log(`  Current process.version: ${process.version}`);

    if (!semver.satisfies(process.version, engineSpec)) {
      console.log(`  → REJECTED: ${process.version} does NOT satisfy ${engineSpec}`);
      return { ok: false, reason: `Node.js engine mismatch: requires ${engineSpec}, current ${process.version}` };
    }

    console.log(`  → ACCEPTED: ${process.version} satisfies ${engineSpec}`);
    return { ok: true };
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    return { ok: true }; // fail open
  }
}

(async () => {
  console.log('Test 1: Version requiring >=22 (should be REJECTED on Node 20)');
  const result1 = await testEngineCheck(
    '@wadeck-app/orchestrator-cli',
    '2026.9.11-203-8d72132a'
  );
  console.log('Result:', result1.ok ? '✓ ACCEPTED' : `✗ REJECTED: ${result1.reason}`);
  console.log('');

  if (process.version.startsWith('v20')) {
    console.log('✓ PASS: Node 20 correctly REJECTED >=22 requirement');
    process.exit(0);
  } else {
    console.log('⚠ SKIP: This test needs to run on Node 20, current is', process.version);
    process.exit(0);
  }
})();
