'use strict';

// A command reaches the shell as ONE string (spawn(line, { shell: true })) instead of bin + args, which node deprecates (DEP0190).
// What matters is that the shell is given the same bytes as before: node used to join [bin, ...args] with single spaces, so the
// line must be that join, not the original command. Each case below runs both ways and compares what the child really received.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { shellCommandLine } = require('../src/shell-command');

// The OLD call is the deprecated one: it is the reference here, so its warning is not the subject of this file.
process.noDeprecation = true;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch shell  line-'));
const script = path.join(dir, 'print  argv.js');
fs.copyFileSync(path.join(__dirname, 'helpers', 'print-argv.js'), script);
const node = `"${process.execPath}"`;
const S = `"${script}"`;

function collect(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out }));
  });
}

function runOld(command) {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
  const [bin, ...args] = parts;
  return collect(spawn(bin, args, { shell: true, windowsHide: true }));
}

function runNew(command) {
  return collect(spawn(shellCommandLine(command), { shell: true, windowsHide: true }));
}

describe('shellCommandLine', () => {
  test('is the tokens re-joined with single spaces', () => {
    assert.equal(shellCommandLine('  a   "b   c"\t\'d  e\'  f  '), 'a "b   c" \'d  e\' f');
  });

  test('a stray quote that opens no string is dropped, as it was', () => {
    assert.equal(shellCommandLine('echo it\'s'), 'echo it s');
  });

  test('a command with no token is kept as is', () => {
    assert.equal(shellCommandLine(''), '');
    assert.equal(shellCommandLine('   '), '   ');
  });
});

describe('what the child receives is identical to the bin + args call', () => {
  const cases = {
    'several spaces inside double quotes': `${node} ${S} "a    b" c`,
    'single quote inside double quotes': `${node} ${S} "it's  here"`,
    'double quotes inside single quotes': `${node} ${S} 'say  "hi"  now'`,
    '&& inside quotes': `${node} ${S} "a && b" "c || d"`,
    '&& between two commands': `${node} ${S} one && ${node} ${S} two`,
    'a Windows path with spaces': `${node} ${S} "C:\Program Files\My  App\run.exe" --x="C:\a b\c"`,
    'blanks and tabs outside quotes': `  ${node}   ${S} \t x    "y   z"   `,
    'a stray quote': `${node} ${S} it's fine`,
    'an empty quoted argument': `${node} ${S} "" x`,
  };
  for (const [name, command] of Object.entries(cases)) {
    test(name, async () => {
      const before = await runOld(command);
      const after = await runNew(command);
      assert.equal(after.code, before.code, `exit code ${after.code} instead of ${before.code}; output: ${after.out}`);
      assert.equal(after.out, before.out);
      // Guards against two identical failures: the reference itself must have run the child.
      assert.ok(before.out.startsWith('['), `the reference run printed no argv (exit ${before.code}): ${before.out}`);
    });
  }
});

describe('why the line is the re-joined tokens and not the original command', () => {
  test('a stray quote: the original text reaches the program differently from what always ran', async () => {
    const command = `${node} ${S} it's fine`;
    const before = await runOld(command);
    const original = await collect(spawn(command, { shell: true, windowsHide: true }));
    assert.deepEqual(JSON.parse(before.out), ['it', 's', 'fine']);
    // cmd.exe hands "it's" over as one argument; a POSIX shell refuses the unterminated quote. Either way it is not the same run.
    assert.notEqual(original.out, before.out);
  });
});
