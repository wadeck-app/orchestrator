'use strict';

// The help is the only reference a user has at the terminal: it must stay readable (<= 100 columns), grouped, and
// complete (every flag the add/edit parser accepts is explained).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { JOB_FIELD_FLAGS, EXTRA_ADD_FLAGS, EXTRA_EDIT_FLAGS } = require('../src/cli');
const { HELP_TEXT, JOB_HELP, JOB_LOGS_HELP } = require('../src/help-text');

describe('help text', () => {
  for (const [name, text] of [['orch --help', HELP_TEXT], ['orch job --help', JOB_HELP], ['orch job <jobId> logs --help', JOB_LOGS_HELP]]) {
    test(`${name}: no line is wider than 100 columns`, () => {
      const wide = text.split('\n').filter((l) => l.length > 100);
      assert.deepEqual(wide, []);
    });
  }

  test('every flag the add and edit parser accepts appears in orch --help', () => {
    const accepted = new Set([
      ...JOB_FIELD_FLAGS.map((f) => f.flag),
      ...EXTRA_ADD_FLAGS,
      ...EXTRA_EDIT_FLAGS,
    ]);
    assert.ok(accepted.size > 25, `the parser tables look empty: ${[...accepted].join(' ')}`);
    const missing = [...accepted].filter((flag) => !new RegExp(`${flag}(?![\\w-])`).test(HELP_TEXT));
    assert.deepEqual(missing, [], `flags accepted by orch add/edit but missing from orch --help: ${missing.join(', ')}`);
  });

  test('the add/edit flags are grouped under headings, each flag under the heading it belongs to', () => {
    const body = HELP_TEXT.split(/^Job options/m)[1].split(/^Schedule format/m)[0];
    const sections = {};
    let current = null;
    for (const line of body.split('\n')) {
      const h = line.match(/^ {2}(\S.*)$/);
      if (h) {
        current = h[1];
        sections[current] = '';
      } else if (current) {
        sections[current] += `${line}\n`;
      }
    }
    assert.deepEqual(Object.keys(sections), ['Identity and description', 'Schedule', 'Execution', 'Timeouts', 'Retry and skip', 'Restart on exit', 'Resource limits', 'Output']);
    const where = {
      'Identity and description': ['--command', '--label', '--description', '--cwd', '--tags', '--secrets', '--env', '--disabled', '--once'],
      Schedule: ['--schedule', '--delay', '--missed-firing', '--active-for', '--active-from', '--active-until', '--liveness-strategy', '--liveness-port-file', '--liveness-command'],
      Execution: ['--trigger-mode', '--max-concurrency', '--depends-on', '--alert-after-failures', '--sla-window', '--dry-run-supported', '--progress', '--progress-options'],
      Timeouts: ['--timeout'],
      'Retry and skip': ['--retry-on-exit-codes', '--retry-delays', '--skip-exit-codes', '--on-exit-code'],
      'Restart on exit': ['--restart-on-exit', '--restart-strategy', '--restart-delay', '--restart-factor', '--restart-step', '--restart-max-delay', '--restart-max', '--restart-window', '--restart-stable-after'],
      'Resource limits': ['--resource-enforce', '--hard-factor', '--soft-factor', '--sustain', '--max-cpu', '--max-ram'],
      Output: ['--json'],
    };
    for (const [heading, flags] of Object.entries(where)) {
      for (const flag of flags) {
        assert.match(sections[heading], new RegExp(`^ {4}${flag}(?![\\w-])`, 'm'), `${flag} must be listed under "${heading}"`);
      }
    }
  });

  test('the Job category lists orch job and the Logs category points to it', () => {
    assert.match(HELP_TEXT, /^Job \(sub-commands of one job/m);
    assert.match(HELP_TEXT, /^Logs:$/m);
  });
});
