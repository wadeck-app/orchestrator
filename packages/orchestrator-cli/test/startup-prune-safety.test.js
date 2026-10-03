'use strict';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPruneStaleBinaries } from '../dist/startup.js';

describe('shouldPruneStaleBinaries', () => {
  it('allows pruning when start-at-login was never enabled', () => {
    assert.equal(shouldPruneStaleBinaries(null), true);
  });

  it('allows pruning once the refresh succeeded', () => {
    assert.equal(shouldPruneStaleBinaries({ ok: true }), true);
  });

  it('refuses pruning when the refresh failed, to keep the old stamp the entry still points at', () => {
    assert.equal(shouldPruneStaleBinaries({ ok: false, error: 'reg.exe failed' }), false);
  });
});
