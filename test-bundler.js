#!/usr/bin/env node
/**
 * Test that orchestrator-updater.cjs (the bundled updater) can be required
 * and contains the engine check function.
 */
const fs = require('node:fs');
const path = require('node:path');

const bundleFile = path.join(__dirname, 'packages/orchestrator-cli/dist/orchestrator-updater.cjs');

console.log('=== Bundler Verification Test ===');
console.log('Current Node:', process.version);
console.log('Bundle file:', bundleFile);
console.log('');

// Check that the bundle exists
if (!fs.existsSync(bundleFile)) {
  console.error('✗ FAIL: Bundle file not found:', bundleFile);
  process.exit(1);
}
console.log('✓ Bundle file exists');

// Check file size
const stats = fs.statSync(bundleFile);
console.log(`✓ Bundle size: ${(stats.size / 1024).toFixed(1)} KB`);

// Check that bundle contains key strings
const bundleContent = fs.readFileSync(bundleFile, 'utf8');

const checks = [
  { name: 'semver library', pattern: /satisfies/ },
  { name: 'engine check function', pattern: /checkEngineCompatibility/ },
  { name: 'error message', pattern: /engine mismatch/ },
  { name: 'npm view call', pattern: /view.*engines\.node/ },
];

console.log('');
console.log('Checking bundle content:');
let allPass = true;
for (const check of checks) {
  const found = check.pattern.test(bundleContent);
  console.log(`  ${found ? '✓' : '✗'} ${check.name}`);
  allPass = allPass && found;
}

console.log('');
if (allPass) {
  console.log('✓ PASS: All components found in bundle');
  process.exit(0);
} else {
  console.log('✗ FAIL: Some components missing from bundle');
  process.exit(1);
}
