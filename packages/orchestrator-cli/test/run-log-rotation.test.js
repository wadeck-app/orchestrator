'use strict';

// RunLogger rotation: the daemon-side writer of a run's log. Tiny limits in bytes and an injected clock, no sleeps.
// The supervisor (supervisor-go/run.go) implements the same rules and has its own tests; the end-to-end agreement
// between the two is in run-log-rotation-supervised.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { RunLogger } = require('../src/logger');
const { listRunSegments } = require('../src/log-rotation');

const STARTED = '2026-10-25T10:00:00.000Z';
const STAMP = '2026-10-25T10-00-00';
const AT = new Date('2026-10-25T10:00:05.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runlog-'));
const entry = (text) => `[2026-10-25 10:00:05] ${text}\n`;
const bytes = (text) => Buffer.byteLength(entry(text));
const names = (dir) => fs.readdirSync(dir).sort();
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

/** All the retained segments of the run, in order, as one text. */
function whole(dir, prefix = 'job') {
  const segs = listRunSegments(dir, prefix).get(STAMP) ?? [];
  return segs.map(s => fs.readFileSync(s.file, 'utf8')).join('');
}

describe('RunLogger without rotation limits', () => {
  test('one file however much is written: no option, no segment', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED);
    for (let i = 0; i < 200; i++) {
      log.write(`line ${i}`, AT);
    }
    log.close();
    assert.deepEqual(names(dir), [`job-${STAMP}.log`]);
  });

  test('maxBytes 0 is rotation off', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 0, keepSegments: 2 } });
    for (let i = 0; i < 50; i++) {
      log.write(`line ${i}`, AT);
    }
    log.close();
    assert.deepEqual(names(dir), [`job-${STAMP}.log`]);
  });
});

describe('RunLogger rotation boundary', () => {
  test('a segment holds exactly maxBytes: the line that fits is written, the next one starts segment 2', () => {
    const dir = tmp();
    const each = bytes('aaaa');
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: each * 3, keepSegments: 10 } });
    for (const t of ['aaaa', 'bbbb', 'cccc', 'dddd']) {
      log.write(t, AT);
    }
    log.close();
    assert.deepEqual(names(dir), [`job-${STAMP}.log`, `job-${STAMP}.log.2`]);
    assert.equal(read(dir, `job-${STAMP}.log`), entry('aaaa') + entry('bbbb') + entry('cccc'));
    assert.equal(fs.statSync(path.join(dir, `job-${STAMP}.log`)).size, each * 3, 'the limit is reached exactly, not passed');
    assert.equal(read(dir, `job-${STAMP}.log.2`), entry('dddd'));
  });

  test('one byte less room: the third line already goes to segment 2', () => {
    const dir = tmp();
    const each = bytes('aaaa');
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: each * 3 - 1, keepSegments: 10 } });
    for (const t of ['aaaa', 'bbbb', 'cccc']) {
      log.write(t, AT);
    }
    log.close();
    assert.equal(read(dir, `job-${STAMP}.log`), entry('aaaa') + entry('bbbb'));
    assert.equal(read(dir, `job-${STAMP}.log.2`), entry('cccc'));
  });

  test('a line longer than the whole limit is written in one piece, alone in its segment', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 40, keepSegments: 10 } });
    const huge = 'x'.repeat(500);
    log.write('a', AT);
    log.write(huge, AT);
    log.write('b', AT);
    log.close();
    assert.equal(read(dir, `job-${STAMP}.log`), entry('a'));
    assert.equal(read(dir, `job-${STAMP}.log.2`), entry(huge));
    assert.equal(read(dir, `job-${STAMP}.log.3`), entry('b'));
  });

  test('a long first line is not preceded by an empty segment', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 40, keepSegments: 10 } });
    log.write('y'.repeat(300), AT);
    log.close();
    assert.deepEqual(names(dir), [`job-${STAMP}.log`]);
  });

  test('no line is lost or split: every segment concatenated reads back the lines in order', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 100, keepSegments: 1000 } });
    const sent = [];
    for (let i = 0; i < 120; i++) {
      const text = `n${i} ${'z'.repeat(i % 37)}`;
      sent.push(entry(text));
      log.write(text, AT);
    }
    log.close();
    assert.equal(whole(dir), sent.join(''));
    const segs = listRunSegments(dir, 'job').get(STAMP);
    assert.ok(segs.length > 10, `expected many segments, got ${segs.length}`);
    for (const s of segs) {
      const text = fs.readFileSync(s.file, 'utf8');
      assert.ok(text.endsWith('\n') && text.startsWith('[2026-'), `segment ${s.n} starts and ends on a line boundary`);
      // Over the limit only when a single line is.
      assert.ok(s.size <= 100 || text.split('\n').length === 2, `segment ${s.n} is ${s.size} bytes`);
    }
  });

  test('writeOutput goes through the same rotation and keeps stripping escape sequences', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 60, keepSegments: 10 }, now: () => AT.getTime() });
    log.writeOutput('\x1b[31mred one\x1b[0m   ');
    log.writeOutput('second line of output');
    log.writeOutput('\x1b[2K');
    log.close();
    assert.match(whole(dir), /red one\n/);
    assert.doesNotMatch(whole(dir), /\x1b/);
    assert.equal(listRunSegments(dir, 'job').get(STAMP).length, 2);
  });
});

describe('RunLogger dropping the oldest segments', () => {
  /** Writes `count` 4-char lines, one per segment (limit = one line). */
  function oneLinePerSegment(dir, count, keep) {
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: bytes('l000'), keepSegments: keep } });
    for (let i = 1; i <= count; i++) {
      log.write(`l${String(i).padStart(3, '0')}`, AT);
    }
    log.close();
  }

  test('only the last keepSegments segments stay', () => {
    const dir = tmp();
    oneLinePerSegment(dir, 8, 3);
    assert.deepEqual(names(dir), [`job-${STAMP}.log.6`, `job-${STAMP}.log.7`, `job-${STAMP}.log.8`]);
  });

  test('fewer segments than keepSegments: nothing is dropped and there is no marker', () => {
    const dir = tmp();
    oneLinePerSegment(dir, 3, 5);
    assert.deepEqual(names(dir), [`job-${STAMP}.log`, `job-${STAMP}.log.2`, `job-${STAMP}.log.3`]);
    assert.doesNotMatch(whole(dir), /log rotation/);
  });

  test('the segment that follows a drop opens with one marker line saying how many earlier segments are gone', () => {
    const dir = tmp();
    oneLinePerSegment(dir, 8, 3);
    const first = read(dir, `job-${STAMP}.log.6`);
    assert.match(first.split('\n')[0], /^\[2026-10-\d\d \d\d:\d\d:\d\d\] \[orch\] log rotation: 3 earlier segments of this run were dropped \(only the last 3 segments are kept, each at most \d+ bytes; see logRotation in docs\/daemon-config\.md\)$/);
    assert.match(read(dir, `job-${STAMP}.log.8`).split('\n')[0], /log rotation: 5 earlier segments/);
    // The marker is not in the way of the run's own lines.
    assert.ok(read(dir, `job-${STAMP}.log.8`).includes('l008'));
  });

  test('the marker is singular for one segment, and a single dropped segment says so', () => {
    const dir = tmp();
    oneLinePerSegment(dir, 3, 2);
    assert.match(read(dir, `job-${STAMP}.log.3`), /log rotation: 1 earlier segment of this run was dropped \(only the last 2 segments are kept/);
    const one = tmp();
    oneLinePerSegment(one, 3, 1);
    assert.match(read(one, `job-${STAMP}.log.3`), /only the last 1 segment is kept/);
  });

  test('a marker alone does not fill a segment: a long line after it does not rotate again', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: 40, keepSegments: 1 } });
    log.write('first', AT);
    log.write('x'.repeat(300), AT);
    log.close();
    const segs = listRunSegments(dir, 'job').get(STAMP);
    assert.deepEqual(segs.map(s => s.n), [2]);
    const lines = fs.readFileSync(segs[0].file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /log rotation: 1 earlier segment/);
    assert.ok(lines[1].endsWith('x'.repeat(300)));
  });

  test('a segment that cannot be deleted does not stop the run, and is deleted at the next rotation', () => {
    const dir = tmp();
    const realUnlink = fs.unlinkSync;
    let failures = 0;
    fs.unlinkSync = (p) => {
      if (String(p).endsWith('.log') && failures < 1) {
        failures++;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return realUnlink(p);
    };
    try {
      oneLinePerSegment(dir, 5, 2);
    } finally {
      fs.unlinkSync = realUnlink;
    }
    assert.equal(failures, 1);
    assert.deepEqual(names(dir), [`job-${STAMP}.log.4`, `job-${STAMP}.log.5`]);
  });
});

describe('RunLogger with several writers on one run', () => {
  test('the daemon and a second writer interleave on the same run: every line once, whole, in order per writer', () => {
    const dir = tmp();
    const rotation = { maxBytes: 120, keepSegments: 1000 };
    const daemon = new RunLogger(dir, 'job', STARTED, { rotation });
    const other = new RunLogger(dir, 'job', STARTED, { rotation });
    const sent = { d: [], o: [] };
    for (let i = 0; i < 60; i++) {
      daemon.write(`daemon ${i}`, AT);
      sent.d.push(`daemon ${i}`);
      other.write(`output ${i} ${'q'.repeat(i % 11)}`, AT);
      sent.o.push(`output ${i} ${'q'.repeat(i % 11)}`);
    }
    daemon.close();
    other.close();
    const lines = whole(dir).split('\n').filter(Boolean).map(l => l.replace(/^\[[^\]]+\] /, ''));
    assert.equal(lines.length, 120);
    assert.deepEqual(lines.filter(l => l.startsWith('daemon')), sent.d);
    assert.deepEqual(lines.filter(l => l.startsWith('output')), sent.o);
    assert.ok(listRunSegments(dir, 'job').get(STAMP).length > 5);
  });

  test('a writer that is behind follows the one that already moved on, instead of writing into the old segment', () => {
    const dir = tmp();
    const rotation = { maxBytes: bytes('aaaa') * 2, keepSegments: 1000 };
    const ahead = new RunLogger(dir, 'job', STARTED, { rotation });
    const behind = new RunLogger(dir, 'job', STARTED, { rotation });
    ahead.write('aaaa', AT);
    ahead.write('bbbb', AT);
    ahead.write('cccc', AT); // segment 2
    behind.write('late', AT); // its own view is segment 1, which is full
    ahead.close();
    behind.close();
    assert.equal(read(dir, `job-${STAMP}.log`), entry('aaaa') + entry('bbbb'));
    assert.equal(read(dir, `job-${STAMP}.log.2`), entry('cccc') + entry('late'));
  });

  test('a writer opened later appends to the newest segment of the run', () => {
    const dir = tmp();
    const rotation = { maxBytes: bytes('aaaa') * 2, keepSegments: 1000 };
    const first = new RunLogger(dir, 'job', STARTED, { rotation });
    for (const t of ['aaaa', 'bbbb', 'cccc']) {
      first.write(t, AT);
    }
    first.close();
    const second = new RunLogger(dir, 'job', STARTED, { rotation });
    second.write('dddd', AT);
    second.write('eeee', AT);
    second.close();
    assert.equal(read(dir, `job-${STAMP}.log.2`), entry('cccc') + entry('dddd'));
    assert.equal(read(dir, `job-${STAMP}.log.3`), entry('eeee'));
  });
});

describe('RunLogger retention applies to the segments', () => {
  const day = 86_400_000;
  const stampOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');

  test('a run past the hard age cap goes with all its segments; a recent run keeps all of them', () => {
    const dir = tmp();
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const oldStamp = stampOf(now - 130 * day);
    const recentStamp = stampOf(now - 2 * day);
    for (const stamp of [oldStamp, recentStamp]) {
      fs.writeFileSync(path.join(dir, `job-${stamp}.log`), 'a\n');
      fs.writeFileSync(path.join(dir, `job-${stamp}.log.2`), 'b\n');
      fs.writeFileSync(path.join(dir, `job-${stamp}.log.3`), 'c\n');
    }
    const log = new RunLogger(dir, 'job', new Date(now).toISOString(), { now: () => now });
    log.close();
    const left = names(dir);
    assert.deepEqual(left.filter(n => n.includes(oldStamp)), []);
    assert.equal(left.filter(n => n.includes(recentStamp)).length, 3);
  });

  test('more than 100 runs: the runs older than 30 days go, counted by run and not by segment file', () => {
    const dir = tmp();
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    // 60 runs of 2 segments, 40 days old: 120 files but only 60 runs, so the "more than 100 runs" rule does not apply.
    for (let i = 0; i < 60; i++) {
      const stamp = stampOf(now - 40 * day + i * 1000);
      fs.writeFileSync(path.join(dir, `job-${stamp}.log`), 'a\n');
      fs.writeFileSync(path.join(dir, `job-${stamp}.log.2`), 'b\n');
    }
    new RunLogger(dir, 'job', new Date(now).toISOString(), { now: () => now }).close();
    assert.equal(names(dir).length, 121, '60 runs x 2 segments kept, plus the new run');
    // 50 more old runs: 110 runs in total, the old ones are now pruned, whole.
    for (let i = 0; i < 50; i++) {
      const stamp = stampOf(now - 41 * day + i * 1000);
      fs.writeFileSync(path.join(dir, `job-${stamp}.log`), 'a\n');
      fs.writeFileSync(path.join(dir, `job-${stamp}.log.2`), 'b\n');
    }
    new RunLogger(dir, 'job', new Date(now + 1000).toISOString(), { now: () => now }).close();
    assert.deepEqual(names(dir).filter(n => !n.includes('2026-10-25T')), []);
  });

  test('another job\'s files are never touched', () => {
    const dir = tmp();
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const old = stampOf(now - 200 * day);
    fs.writeFileSync(path.join(dir, `other-${old}.log`), 'x');
    fs.writeFileSync(path.join(dir, `other-${old}.log.2`), 'x');
    new RunLogger(dir, 'job', new Date(now).toISOString(), { now: () => now }).close();
    assert.equal(names(dir).filter(n => n.startsWith('other-')).length, 2);
  });
});

describe('RunLogger failures', () => {
  test('a segment that cannot be created is reported once and the line is written to the current segment instead of lost', () => {
    const dir = tmp();
    const log = new RunLogger(dir, 'job', STARTED, { rotation: { maxBytes: bytes('aaaa'), keepSegments: 5 } });
    // The next segment's path is a directory: it can be neither created nor opened as a file.
    fs.mkdirSync(path.join(dir, `job-${STAMP}.log.2`));
    const realWrite = process.stderr.write;
    const said = [];
    process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
    try {
      log.write('aaaa', AT);
      log.write('bbbb', AT);
      log.write('cccc', AT);
    } finally {
      process.stderr.write = realWrite;
    }
    log.close();
    assert.equal(read(dir, `job-${STAMP}.log`), entry('aaaa') + entry('bbbb') + entry('cccc'));
    assert.equal(said.filter(s => s.includes('[RunLogger]')).length, 1, said.join(''));
    assert.match(said.join(''), /cannot start the next log segment.*job-2026-10-25T10-00-00\.log\.2/s);
  });
});
