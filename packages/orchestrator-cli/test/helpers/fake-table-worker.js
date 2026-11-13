'use strict';

// A stand-in for the long-lived PowerShell of process-table.ts: reads one line per query on stdin and answers with
// rows and the end marker. argv[2] picks what it does: ok | error | hang | crash. It ends when stdin ends, like the
// real one, which is what keeps it from outliving the daemon.
const readline = require('node:readline');

const mode = process.argv[2] ?? 'ok';
let queries = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {
  queries++;
  if (mode === 'hang') {
    return;
  }
  if (mode === 'crash') {
    process.exit(7);
  }
  if (mode === 'error') {
    process.stdout.write('##ERR access denied by the fake\n##END\n');
    return;
  }
  process.stdout.write(`${process.pid} 0 0 0 0\n${queries} 0 0 0 0\n##END\n`);
});
rl.on('close', () => process.exit(0));
