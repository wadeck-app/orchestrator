'use strict';

// The publish job picks its supervisor and its npm dist tag from the head commit message of a push (trailer lines) or from
// the workflow_dispatch inputs. The message is untrusted text, so besides the parsing rules this file checks that it is
// never interpreted by the shell.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'ci', 'scripts', 'resolve-publish-channel.sh');

function run(env, cwd) {
  const r = spawnSync('bash', [SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return r;
}

const push = (message, cwd) => run({ EVENT_NAME: 'push', COMMIT_MESSAGE: message }, cwd);

function assertChannel(r, supervisor, tag) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `SUPERVISOR_IMPL=${supervisor}\nDIST_TAG_OVERRIDE=${tag}\n`);
}

describe('resolve-publish-channel.sh: push', () => {
  test('no trailers: go supervisor and no override, as before', () => {
    assertChannel(push('Fix the thing\n\nA body line.\nAnother one.'), 'go', '');
  });

  test('empty commit message: go and no override', () => {
    assertChannel(push(''), 'go', '');
  });

  test('both trailers amid a normal multi-line message, with CRLF and trailing spaces', () => {
    const msg = 'Add a feature\r\n\r\nSome explanation of the change.\r\nSupervisor: rust  \r\nPublish-Tag: rust-next \t\r\n\r\nCo-authored-by: someone';
    assertChannel(push(msg), 'rust', 'rust-next');
  });

  test('Supervisor: go is accepted', () => {
    assertChannel(push('msg\n\nSupervisor: go'), 'go', '');
  });

  test('the last occurrence wins', () => {
    const msg = 'msg\n\nSupervisor: go\nPublish-Tag: first\nSupervisor: rust\nPublish-Tag: second.tag_2';
    assertChannel(push(msg), 'rust', 'second.tag_2');
  });

  test('keys are case-sensitive and line-anchored: other lines are ignored', () => {
    const msg = 'msg\n\nsupervisor: rust\npublish-tag: x\n  Supervisor: rust\nSee Supervisor: rust and Publish-Tag: foo here';
    assertChannel(push(msg), 'go', '');
  });

  // The workflow's guard step ("Guard a Rust supervisor build against the latest tag") fails the run later, when
  // SUPERVISOR_IMPL=rust and the dist tag resolves to latest. This script only reports what was asked for.
  test('Supervisor: rust without Publish-Tag prints rust and an empty tag (the guard step fails it later)', () => {
    assertChannel(push('msg\n\nSupervisor: rust'), 'rust', '');
  });

  for (const [label, tag] of [['uppercase', 'Rust-Next'], ['a space inside', 'rust next'], ['a leading dash', '-rust'], ['a leading dot', '.rust'], ['an empty value', '']]) {
    test(`Publish-Tag with ${label} fails with an actionable message`, () => {
      const r = push(`msg\n\nPublish-Tag: ${tag}`);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /Invalid dist tag/);
      assert.ok(r.stderr.includes(`'${tag}'`), r.stderr);
      assert.ok(r.stderr.includes('^[a-z0-9][a-z0-9._-]*$'), r.stderr);
      assert.match(r.stderr, /Example.*Publish-Tag: rust-next/);
    });
  }

  test('an unknown Supervisor value fails with an actionable message', () => {
    const r = push('msg\n\nSupervisor: Rust');
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Invalid supervisor 'Rust'/);
    assert.match(r.stderr, /go, rust/);
    assert.match(r.stderr, /Example.*Supervisor: rust/);
  });
});

describe('resolve-publish-channel.sh: other events', () => {
  test('workflow_dispatch takes the inputs and ignores the message', () => {
    const r = run({ EVENT_NAME: 'workflow_dispatch', COMMIT_MESSAGE: 'Supervisor: rust\nPublish-Tag: ignored', INPUT_SUPERVISOR_IMPL: 'rust', INPUT_DIST_TAG: 'rust-next' });
    assertChannel(r, 'rust', 'rust-next');
  });

  test('workflow_dispatch with default inputs: go and no override', () => {
    assertChannel(run({ EVENT_NAME: 'workflow_dispatch', INPUT_SUPERVISOR_IMPL: 'go', INPUT_DIST_TAG: '' }), 'go', '');
  });

  test('workflow_dispatch with an invalid tag fails', () => {
    const r = run({ EVENT_NAME: 'workflow_dispatch', INPUT_SUPERVISOR_IMPL: 'rust', INPUT_DIST_TAG: 'Bad Tag' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid dist tag 'Bad Tag'/);
  });

  test('pull_request: go and no override, trailers and inputs ignored', () => {
    const r = run({ EVENT_NAME: 'pull_request', COMMIT_MESSAGE: 'Supervisor: rust\nPublish-Tag: x', INPUT_SUPERVISOR_IMPL: 'rust', INPUT_DIST_TAG: 'y' });
    assertChannel(r, 'go', '');
  });
});

describe('resolve-publish-channel.sh: the message is never executed', () => {
  test('shell metacharacters in the message create nothing and do not break the output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-channel-'));
    try {
      const msg = [
        'Fix $(touch pwned-subst) and `touch pwned-backtick`',
        '',
        '"; touch pwned-quote; echo "',
        "'; touch pwned-single; echo '",
        '$(touch pwned-subst2)',
        'Supervisor: rust',
        'Publish-Tag: rust-next',
      ].join('\n');
      assertChannel(push(msg, dir), 'rust', 'rust-next');
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('metacharacters in a trailer value are rejected as an invalid tag, not executed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-channel-'));
    try {
      const r = push('msg\n\nPublish-Tag: $(touch pwned-tag)', dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Invalid dist tag/);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
