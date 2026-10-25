'use strict';

// Size-based rotation of the log of ONE run: the pure rules (setting validation, resolution against the daemon default,
// segment naming and listing). The writers have their own files: run-log-rotation.test.js (RunLogger) and
// supervisor-go/run_test.go (the supervisor).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  LOG_ROTATION_DEFAULTS, LOG_ROTATION_KEYS, logRotationError, resolveLogRotation,
  segmentPath, parseSegmentName, listRunSegments, formatLimit,
} = require('../src/log-rotation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logrot-'));

describe('logRotationError', () => {
  test('absent, null and a full or partial object are valid', () => {
    assert.equal(logRotationError(undefined), null);
    assert.equal(logRotationError(null), null);
    assert.equal(logRotationError({ maxSizeMb: 50, keepSegments: 5 }), null);
    assert.equal(logRotationError({ maxSizeMb: 0.5 }), null);
    assert.equal(logRotationError({ keepSegments: 1 }), null);
    // 0 turns the rotation off for the job.
    assert.equal(logRotationError({ maxSizeMb: 0 }), null);
  });

  test('the defaults are documented values: 50 MB, 5 segments', () => {
    assert.deepEqual({ ...LOG_ROTATION_DEFAULTS }, { maxSizeMb: 50, keepSegments: 5 });
    assert.deepEqual([...LOG_ROTATION_KEYS], ['maxSizeMb', 'keepSegments']);
  });

  const refused = [
    [true, /logRotation must be an object/],
    ['big', /logRotation must be an object/],
    [[1], /logRotation must be an object/],
    [{}, /logRotation is empty.*maxSizeMb.*keepSegments.*--unset logRotation/s],
    [{ maxSize: 5 }, /unknown key "maxSize".*maxSizeMb, keepSegments/],
    [{ maxSizeMb: -1 }, /logRotation\.maxSizeMb.*-1.*0 turns the rotation off/s],
    [{ maxSizeMb: 'x' }, /logRotation\.maxSizeMb.*"x"/],
    [{ maxSizeMb: Number.NaN }, /logRotation\.maxSizeMb/],
    [{ maxSizeMb: Number.POSITIVE_INFINITY }, /logRotation\.maxSizeMb/],
    [{ maxSizeMb: 0.0001 }, /logRotation\.maxSizeMb.*at least 0\.001/s],
    [{ maxSizeMb: 20000 }, /logRotation\.maxSizeMb.*at most 10240/s],
    [{ keepSegments: 0 }, /logRotation\.keepSegments.*whole number from 1 to 1000.*got: 0/s],
    [{ keepSegments: 1.5 }, /logRotation\.keepSegments.*whole number/],
    [{ keepSegments: 1001 }, /logRotation\.keepSegments.*from 1 to 1000/],
    [{ keepSegments: '5' }, /logRotation\.keepSegments.*"5"/],
  ];
  for (const [value, pattern] of refused) {
    test(`refuses ${JSON.stringify(value)} with a sentence that says what to do`, () => {
      const problem = logRotationError(value);
      assert.notEqual(problem, null);
      assert.match(problem, pattern);
    });
  }
});

describe('resolveLogRotation', () => {
  const daemon = { maxBytes: 50 * 1048576, keepSegments: 5 };

  test('no job setting: the daemon default', () => {
    assert.deepEqual(resolveLogRotation(undefined, daemon), daemon);
  });

  test('a job key replaces the daemon value, the other key stays the daemon one', () => {
    assert.deepEqual(resolveLogRotation({ maxSizeMb: 2 }, daemon), { maxBytes: 2 * 1048576, keepSegments: 5 });
    assert.deepEqual(resolveLogRotation({ keepSegments: 9 }, daemon), { maxBytes: 50 * 1048576, keepSegments: 9 });
  });

  test('fractions of a MB are bytes, rounded', () => {
    assert.equal(resolveLogRotation({ maxSizeMb: 0.001 }, daemon).maxBytes, 1049);
  });

  test('maxSizeMb 0 is rotation off (maxBytes 0), whatever the daemon says', () => {
    assert.equal(resolveLogRotation({ maxSizeMb: 0 }, daemon).maxBytes, 0);
  });
});

describe('segment names', () => {
  test('segment 1 is the plain run file, the others carry a number after .log', () => {
    assert.equal(segmentPath('/l/job-2026-10-25T10-00-00.log', 1), '/l/job-2026-10-25T10-00-00.log');
    assert.equal(segmentPath('/l/job-2026-10-25T10-00-00.log', 2), '/l/job-2026-10-25T10-00-00.log.2');
    assert.equal(segmentPath('/l/job-2026-10-25T10-00-00.log', 13), '/l/job-2026-10-25T10-00-00.log.13');
  });

  test('parseSegmentName reads a segment of this job and nothing else', () => {
    assert.deepEqual(parseSegmentName('job', 'job-2026-10-25T10-00-00.log'), { stamp: '2026-10-25T10-00-00', n: 1 });
    assert.deepEqual(parseSegmentName('job', 'job-2026-10-25T10-00-00.log.7'), { stamp: '2026-10-25T10-00-00', n: 7 });
    for (const bad of ['job-2026-10-25.log', 'job-2026-10-25T10-00-00.log.1', 'job-2026-10-25T10-00-00.log.0', 'job-2026-10-25T10-00-00.log.x',
      'job-2026-10-25T10-00-00.log.2.tmp', 'other-2026-10-25T10-00-00.log', 'job2-2026-10-25T10-00-00.log', 'job-2026-10-25T10-00-00.txt']) {
      assert.equal(parseSegmentName('job', bad), null, bad);
    }
  });

  test('a job id with regex characters is matched literally', () => {
    assert.deepEqual(parseSegmentName('a.b', 'a.b-2026-10-25T10-00-00.log'), { stamp: '2026-10-25T10-00-00', n: 1 });
    assert.equal(parseSegmentName('a.b', 'aXb-2026-10-25T10-00-00.log'), null);
  });

  test('formatLimit says megabytes for whole megabytes and bytes otherwise', () => {
    assert.equal(formatLimit(50 * 1048576), '50 MB');
    assert.equal(formatLimit(1048576), '1 MB');
    assert.equal(formatLimit(1500), '1500 bytes');
  });
});

describe('listRunSegments', () => {
  test('groups the segments of each run in numeric order, sizes included, and ignores everything else', () => {
    const dir = tmp();
    const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
    put('job-2026-10-25T10-00-00.log', 'aaa');
    put('job-2026-10-25T10-00-00.log.2', 'bb');
    put('job-2026-10-25T10-00-00.log.10', 'c');
    put('job-2026-10-26T08-00-00.log', 'dddd');
    put('job-2026-10-25.log', 'legacy daily');
    put('other-2026-10-25T10-00-00.log', 'other job');
    const runs = listRunSegments(dir, 'job');
    assert.deepEqual([...runs.keys()], ['2026-10-25T10-00-00', '2026-10-26T08-00-00']);
    assert.deepEqual(runs.get('2026-10-25T10-00-00').map(s => [s.n, s.size, path.basename(s.file)]), [
      [1, 3, 'job-2026-10-25T10-00-00.log'], [2, 2, 'job-2026-10-25T10-00-00.log.2'], [10, 1, 'job-2026-10-25T10-00-00.log.10'],
    ]);
  });

  test('a run whose first segment was dropped is still a run', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'job-2026-10-25T10-00-00.log.4'), 'x');
    fs.writeFileSync(path.join(dir, 'job-2026-10-25T10-00-00.log.5'), 'y');
    assert.deepEqual(listRunSegments(dir, 'job').get('2026-10-25T10-00-00').map(s => s.n), [4, 5]);
  });

  test('a missing folder has no runs', () => {
    assert.equal(listRunSegments(path.join(tmp(), 'nope'), 'job').size, 0);
  });
});
