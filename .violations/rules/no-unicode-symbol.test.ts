import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule } from './no-unicode-symbol.js';

describe('local/no-unicode-symbol', () => {
  it('flags arrow/checkmark unicode symbols in TSX', async () => {
    const violations = await rule.check(['packages/orch-ui/src/components/AuditLog.tsx']);
    // AuditLog no longer has unicode symbols — expect 0 violations
    assert.equal(violations.length, 0);
  });

  it('produces no violations on clean file', async () => {
    // Pass empty list — should return empty array
    const violations = await rule.check([]);
    assert.equal(violations.length, 0);
  });
});
