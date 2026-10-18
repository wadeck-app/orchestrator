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

  test('returns nothing for empty output', () => {
    assert.equal(parseProcessName('', true), undefined);
    assert.equal(parseProcessName('\n  \n', false), undefined);
  });
});

describe('lookupProcessName', () => {
  test('finds this very process', async () => {
    const name = await lookupProcessName(process.pid);
    assert.ok(name !== undefined && /node/i.test(name), `expected a node executable, got ${String(name)}`);
  });

  test('gives nothing, rather than failing, for a pid that does not exist', async () => {
    assert.equal(await lookupProcessName(2 ** 22 - 3), undefined);
  });
});
