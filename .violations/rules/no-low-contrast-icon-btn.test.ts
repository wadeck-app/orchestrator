import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule } from './no-low-contrast-icon-btn.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function withTempFile(content: string, fn: (file: string) => Promise<void>): Promise<void> {
  const file = path.join(os.tmpdir(), `test-${Date.now()}.tsx`);
  fs.writeFileSync(file, content, 'utf-8');
  return fn(file).finally(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });
}

describe('no-low-contrast-icon-btn', () => {
  it('flags text-muted + bg-muted-bg on same className', async () => {
    await withTempFile(
      `<button className="p-2 bg-muted-bg text-muted border">icon</button>`,
      async (file) => {
        const violations = await rule.check([file]);
        assert.equal(violations.length, 1);
        assert.match(violations[0]!.message, /Low contrast/);
      }
    );
  });

  it('does not flag text-muted without bg-muted-bg', async () => {
    await withTempFile(
      `<button className="p-2 bg-surface text-muted border">icon</button>`,
      async (file) => {
        const violations = await rule.check([file]);
        assert.equal(violations.length, 0);
      }
    );
  });

  it('does not flag text-content + bg-muted-bg (good contrast)', async () => {
    await withTempFile(
      `<button className="p-2 bg-muted-bg text-content border">icon</button>`,
      async (file) => {
        const violations = await rule.check([file]);
        assert.equal(violations.length, 0);
      }
    );
  });
});
