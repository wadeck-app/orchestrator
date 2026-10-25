'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseProcessName, lookupProcessName } = require('../src/process-name');

describe('parseProcessName', () => {
  test('reads the image name from tasklist\'s CSV on Windows', () => {
    assert.equal(parseProcessName('"chatgpt-scraper.exe","4242","Console","1","123,456 K"\r\n', true), 'chatgpt-scraper.exe');
  });

  test('does not take tasklist\'s "no match" message for a name', () => {
    assert.equal(parseProcessName('INFO: No tasks are running which match the specified criteria.\r\n', true), undefined);
  });

  test('reads the bare name ps prints elsewhere', () => {
    assert.equal(parseProcessName('node\n', false), 'node');
  });

  test('keeps only the file name of the full path macOS prints', () => {
    assert.equal(parseProcessName('/opt/homebrew/Cellar/node/24.1.0/bin/node\n', false), 'node');
  });

  test('returns nothing for empty output', () => {
    assert.equal(parseProcessName('', true), undefined);
    assert.equal(parseProcessName('\n  \n', false), undefined);
  });
});

describe('lookupProcessName', () => {
  test('finds this very process', async () => {
    // The real tasklist/ps, given all the time it needs: the 5 s patience of the kill path answers "no name" on a machine
    // too busy to run the tool in time (measured: 5.1 s with every core busy), which is not what is tested here.
    const name = await lookupProcessName(process.pid, { timeoutMs: 110_000 });
    assert.ok(name !== undefined && /node/i.test(name), `expected a node executable, got ${String(name)}`);
  });

  test('gives nothing, rather than failing, for a pid that does not exist', async () => {
    assert.equal(await lookupProcessName(2 ** 22 - 3, { timeoutMs: 110_000 }), undefined);
  });
});
