import fs from 'fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

for (let i = 0; i < lines.length; i++) {
  try {
    const obj = JSON.parse(lines[i]);
    const c = obj.message?.content;
    if (!c) continue;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
    if (/rank\s*1|r1:|webhook.*cli|cli.*event|queue.*notif|notif.*queue|NOTIF-01|r2:|alert.*queue|notification.*queue|push.*notif|job.*event.*cli/i.test(text)) {
      console.log(`[L${i+1}][${obj.type}]`);
      console.log(text.slice(0, 800));
      console.log('---');
    }
  } catch {}
}
