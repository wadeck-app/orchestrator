// Diagnostic: test if shared-cli loads cleanly
try {
  require('@wadeck-app/shared-cli');
  console.log('shared-cli: OK');
} catch(e) {
  console.error('shared-cli FAIL:', e.message, e.stack);
  process.exit(1);
}

// Test early crash scenario with running daemon port
const net = require('net');
const client = net.createConnection({ port: 47900, host: '127.0.0.1' });
client.on('connect', () => { console.log('port 47900: reachable'); client.destroy(); });
client.on('error', (e) => { console.log('port 47900: not reachable -', e.message); });
