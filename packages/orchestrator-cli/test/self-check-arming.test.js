import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { armSelfCheck, FAILING_SELF_CHECK_MARKER } from '../src/updater/self-check-target.ts';

const NODE = 'C:\Program Files\nodejs\node.exe';

// shared-updater repairs a journaled 'applying' install before it looks at anything else, and the repair keeps the
// target version only if the self-check passes. entry.ts used to abort the whole run when the self-check could not
// be armed (package half-removed: no bin.orch), which is exactly the state an interrupted install leaves, so the
// repair never ran and the CLI stayed broken.
describe('armSelfCheck', () => {
  test('a resolvable target is armed with both paths quoted', () => {
    const res = armSelfCheck({ nodeExe: NODE, resolved: { ok: true, target: 'C:\npm\orch.js' }, interrupted: false });
    assert.deepEqual(res, { command: `"${NODE}" "C:\npm\orch.js" cli self-check` });
  });

  test('an unresolvable target aborts a normal run: an unverified update would not be rollback-able', () => {
    const res = armSelfCheck({ nodeExe: NODE, resolved: { ok: false, reason: 'cannot read x' }, interrupted: false });
    assert.equal(res.command, undefined);
    assert.match(res.abort, /cannot read x/);
    assert.match(res.abort, /npm install -g @wadeck-app\/orchestrator-cli@latest/);
  });

  test('with an interrupted install journaled, an unresolvable target arms a self-check that FAILS, so the repair restores the previous version', () => {
    const res = armSelfCheck({ nodeExe: NODE, resolved: { ok: false, reason: 'cannot read x' }, interrupted: true });
    assert.equal(res.abort, undefined);
    assert.ok(res.command.includes(FAILING_SELF_CHECK_MARKER), res.command);
    assert.ok(res.command.startsWith(`"${NODE}" `), res.command);
    assert.match(res.note, /cannot read x/);
  });

  test('with an interrupted install journaled, a resolvable target is armed normally', () => {
    const res = armSelfCheck({ nodeExe: NODE, resolved: { ok: true, target: '/p/orch.js' }, interrupted: true });
    assert.equal(res.command, `"${NODE}" "/p/orch.js" cli self-check`);
  });
});
