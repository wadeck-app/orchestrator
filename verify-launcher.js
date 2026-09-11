const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const configDir = path.join(os.homedir(), '.config', 'orchestrator');

// Try to resolve from platform package first
let launcher = null;
try {
  launcher = require.resolve('@wadeck-app/orchestrator-cli-win32-x64/orchestrator.exe');
} catch (e) {
  console.log('Platform package not found, trying local path...');
  launcher = path.join(__dirname, 'packages', 'orchestrator-cli', 'launcher-go', 'dist', 'orchestrator.exe');
}

if (!fs.existsSync(launcher)) {
  console.error('ERROR: launcher not found at:', launcher);
  process.exit(1);
}

console.log('Launcher found at:', launcher);
console.log('File exists:', fs.existsSync(launcher));

const cmdQuote = (s) => '"' + s.replace(/"/g, '""') + '"';
const newCmd = cmdQuote(launcher) + ' ' + cmdQuote(configDir);
const regValueName = 'Orchestrator (' + configDir + ')';

console.log('');
console.log('Setting registry to use launcher from:', launcher);
console.log('New command:', newCmd);
console.log('');

try {
  execFileSync('reg', [
    'add',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v', regValueName,
    '/t', 'REG_SZ',
    '/d', newCmd,
    '/f'
  ], { stdio: 'pipe', windowsHide: true });
  console.log('✓ Registry updated successfully');
} catch (e) {
  console.error('✗ Registry update failed:', e.message);
  process.exit(1);
}
