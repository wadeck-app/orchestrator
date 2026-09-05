import fs from 'fs';
import path from 'path';

const files = [
  'C:/Users/Wadeck/.claude/projects/C--Workspace-Tooling-orchestrator/508a6a16-937e-4976-89d1-567d105b63a7.jsonl',
  'C:/Users/Wadeck/.claude/projects/C--Workspace-Tooling-orchestrator/9fa59431-6e22-404c-96fc-d9512c8206eb.jsonl',
  'C:/Users/Wadeck/.claude/projects/C--Workspace-Tooling-orchestrator/da729a25-f740-4ee8-acbf-fea9feebd4e4.jsonl',
];

const keywords = /webhook|notif.?01|notif|queue|event|http/i;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  console.log(`\n=== ${path.basename(file)} ===`);
  lines.forEach((line, i) => {
    try {
      const obj = JSON.parse(line);
      if (!obj.message) return;
      const role = obj.type;
      const c = obj.message.content;
      let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
      if (!text || !keywords.test(text)) return;
      // For assistant, only show if it mentions NOTIF-01 specifically or proposes webhooks
      if (role === 'assistant' && !/NOTIF.?01|webhook.*http|http.*webhook|propose.*webhook|notification.*http/i.test(text)) return;
      console.log(`[L${i+1}][${role}] ${text.slice(0, 600)}`);
      console.log('---');
    } catch {}
  });
}
