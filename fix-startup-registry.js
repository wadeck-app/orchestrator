const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// buildWindowsCommand logic
const configDir = path.join(os.homedir(), '.config', 'orchestrator');
const launcher = path.join(__dirname, 'packages', 'orchestrator-cli', 'launcher-go', 'dist', 'orchestrator.exe');

if (!fs.existsSync(launcher)) {
  console.error('ERROR: launcher not found at:', launcher);
  process.exit(1);
}

const cmdQuote = (s) => '"' + s.replace(/"/g, '""') + '"';
const newCmd = cmdQuote(launcher) + ' ' + cmdQuote(configDir);
const regValueName = 'Orchestrator (' + configDir + ')';

console.log('Fixing startup registry...');
console.log('Config dir:', configDir);
console.log('Launcher path:', launcher);
console.log('New registry command:', newCmd);
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
  console.log('');
  console.log('Next time Windows starts, the daemon will launch silently (via launcher Go).');
} catch (e) {
  console.error('✗ Registry update failed:', e.message);
  process.exit(1);
}
