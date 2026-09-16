import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSelfCheckTarget } from '../src/updater/self-check-target.ts';

const PKG = '@wadeck-app/orchestrator-cli';

// Builds a fake global npm root containing the package, with the given manifest and files.
function fakeNpmRoot(manifest, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sct-'));
  const pkgDir = path.join(root, PKG);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
  for (const f of files) {
    const p = path.join(pkgDir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  }
  return root;
}

describe('resolveSelfCheckTarget', () => {
  test('resolves bin.orch and returns its absolute path', () => {
    const root = fakeNpmRoot({ bin: { orch: 'bin/orch.js' } }, ['bin/orch.js']);
    const res = resolveSelfCheckTarget(root, PKG);
    assert.equal(res.ok, true);
    assert.equal(res.target, path.join(root, PKG, 'bin', 'orch.js'));
  });

  // The laptop's failure: the armed path was never shipped, so the self-check always failed and
  // shared-updater rolled back every update forever. Refusing to arm is what breaks that loop.
  test('refuses to arm when bin.orch is declared but absent on disk', () => {
    const root = fakeNpmRoot({ bin: { orch: 'dist/cli.js' } }, []);
    const res = resolveSelfCheckTarget(root, PKG);
    assert.equal(res.ok, false);
    assert.match(res.reason, /dist[\\/]cli\.js.*does not exist/);
  });

  test('refuses to arm when the manifest declares no bin.orch', () => {
    const root = fakeNpmRoot({ bin: { other: 'bin/other.js' } }, ['bin/other.js']);
    const res = resolveSelfCheckTarget(root, PKG);
    assert.equal(res.ok, false);
    assert.match(res.reason, /no bin\.orch entry/);
  });

  test('refuses to arm when the package is not installed at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sct-empty-'));
    const res = resolveSelfCheckTarget(root, PKG);
    assert.equal(res.ok, false);
    assert.match(res.reason, /cannot read/);
  });

  test('refuses to arm on a malformed manifest instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sct-bad-'));
    const pkgDir = path.join(root, PKG);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{ not json');
    const res = resolveSelfCheckTarget(root, PKG);
    assert.equal(res.ok, false);
    assert.match(res.reason, /cannot read/);
  });

  // Guards the actual regression class: the real published manifest must point bin.orch at a file
  // that `files` ships, otherwise every deployed client's self-check breaks irrecoverably.
  test('the real package manifest points bin.orch at a published path', () => {
    const pkgRoot = path.join(import.meta.dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const binRel = manifest.bin.orch;
    assert.ok(fs.existsSync(path.join(pkgRoot, binRel)), `${binRel} missing from the checkout`);
    const shipped = manifest.files.some(
      (f) => binRel === f || (f.endsWith('/') && binRel.startsWith(f)),
    );
    assert.ok(shipped, `bin.orch=${binRel} is not covered by files: ${manifest.files.join(', ')}`);
  });
});
