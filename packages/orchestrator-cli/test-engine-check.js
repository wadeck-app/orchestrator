#!/usr/bin/env node
const semver = require('semver');

console.log('=== semver.satisfies() test ===');
console.log('Current Node:', process.version);
console.log('');
console.log('Test cases:');
console.log('  v20.15.1 satisfies >=22?', semver.satisfies('v20.15.1', '>=22')); // should be false
console.log('  v22.0.0 satisfies >=22?', semver.satisfies('v22.0.0', '>=22')); // should be true
console.log('  v20.15.1 satisfies >=20?', semver.satisfies('v20.15.1', '>=20')); // should be true
console.log('');
console.log('Current process.version against >=22:', semver.satisfies(process.version, '>=22'));
console.log('Current process.version against >=20:', semver.satisfies(process.version, '>=20'));
