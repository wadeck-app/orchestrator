#!/usr/bin/env node
const { execSync } = require('node:child_process');

console.log('=== Test npm view engines.node ===');
console.log('');

// Test with the current version that requires >=22
const version = '2026.9.11-203-8d72132a';
const pkgName = '@wadeck-app/orchestrator-cli';

try {
  const npmView = execSync(
    `npm view ${pkgName}@${version} engines.node --json`,
    { encoding: 'utf8', timeout: 10_000 }
  ).trim();

  console.log(`npm view output (raw): "${npmView}"`);

  const engineSpec = JSON.parse(npmView);
  console.log(`Parsed engines.node: "${engineSpec}"`);
  console.log(`Type: ${typeof engineSpec}`);
} catch (err) {
  console.error('Error:', err.message);
}

console.log('');
console.log('=== Test with a package without engines ===');
try {
  const npmView = execSync(
    `npm view @types/node engines --json`,
    { encoding: 'utf8', timeout: 10_000 }
  ).trim();

  console.log(`npm view @types/node engines (raw): "${npmView}"`);
} catch (err) {
  console.error('Error:', err.message);
}
