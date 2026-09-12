'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { SecretsManager } = require('../src/secrets');

describe('SecretsManager', () => {
  let tmpDir;
  let manager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `secrets-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new SecretsManager(tmpDir);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('set/get roundtrip', () => {
    test('encrypts and decrypts value correctly', () => {
      manager.set('db-password', 'super-secret-123');
      const decrypted = manager.get('db-password');
      assert.equal(decrypted, 'super-secret-123');
    });

    test('handles empty string values', () => {
      manager.set('empty', '');
      assert.equal(manager.get('empty'), '');
    });

    test('handles special characters', () => {
      const secret = 'p@$$w0rd!#%&*()[]{}';
      manager.set('special', secret);
      assert.equal(manager.get('special'), secret);
    });

    test('handles unicode', () => {
      const secret = 'パスワード🔐';
      manager.set('unicode', secret);
      assert.equal(manager.get('unicode'), secret);
    });

    test('returns null for non-existent key', () => {
      assert.equal(manager.get('nonexistent'), null);
    });
  });

  describe('list/delete', () => {
    test('lists all secret names', () => {
      manager.set('secret1', 'val1');
      manager.set('secret2', 'val2');
      manager.set('secret3', 'val3');

      const names = manager.list().sort();
      assert.deepEqual(names, ['secret1', 'secret2', 'secret3']);
    });

    test('delete removes a secret', () => {
      manager.set('to-delete', 'value');
      assert.ok(manager.list().includes('to-delete'));

      manager.delete('to-delete');
      assert.equal(manager.get('to-delete'), null);
      assert.ok(!manager.list().includes('to-delete'));
    });

    test('delete nonexistent key is safe', () => {
      manager.delete('nonexistent');
      assert.deepEqual(manager.list(), []);
    });

    test('list returns empty array for new manager', () => {
      assert.deepEqual(manager.list(), []);
    });
  });

  describe('Corruption and errors', () => {
    test('handles corrupted secrets.json gracefully', () => {
      const secretFile = path.join(tmpDir, 'secrets.json');
      fs.writeFileSync(secretFile, 'invalid json {]', 'utf8');

      const newManager = new SecretsManager(tmpDir);
      assert.deepEqual(newManager.list(), []);
    });

    test('get returns null for corrupted encrypted data', () => {
      manager.set('real-secret', 'value');

      // Corrupt the encrypted value
      const secretFile = path.join(tmpDir, 'secrets.json');
      const data = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
      data['real-secret'] = 'invalid-base64-!!!';
      fs.writeFileSync(secretFile, JSON.stringify(data), 'utf8');

      const newManager = new SecretsManager(tmpDir);
      assert.equal(newManager.get('real-secret'), null);
    });

    test('get returns null for truncated encrypted data', () => {
      manager.set('secret', 'value');

      // Truncate the encrypted value (remove last chars)
      const secretFile = path.join(tmpDir, 'secrets.json');
      const data = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
      data['secret'] = data['secret'].slice(0, -10);
      fs.writeFileSync(secretFile, JSON.stringify(data), 'utf8');

      const newManager = new SecretsManager(tmpDir);
      assert.equal(newManager.get('secret'), null);
    });

    test('handles permission errors gracefully', function() {
      // Skip on Windows where permission simulation is complex
      if (process.platform === 'win32') this.skip();

      manager.set('secret', 'value');
      const secretFile = path.join(tmpDir, 'secrets.json');

      // Remove read permissions
      fs.chmodSync(secretFile, 0o000);

      try {
        const newManager = new SecretsManager(tmpDir);
        // Should handle permission error and return empty
        assert.deepEqual(newManager.list(), []);
      } finally {
        fs.chmodSync(secretFile, 0o644);
      }
    });
  });

  describe('resolveForJob', () => {
    test('returns only requested secrets', () => {
      manager.set('db-pass', 'secret1');
      manager.set('api-key', 'secret2');
      manager.set('token', 'secret3');

      const resolved = manager.resolveForJob(['db-pass', 'api-key']);
      assert.deepEqual(resolved, {
        'db-pass': 'secret1',
        'api-key': 'secret2',
      });
    });

    test('skips nonexistent secrets', () => {
      manager.set('exists', 'value');

      const resolved = manager.resolveForJob(['exists', 'nonexistent', 'also-missing']);
      assert.deepEqual(resolved, { exists: 'value' });
    });

    test('resolveForJob with empty list returns empty', () => {
      manager.set('secret', 'value');

      const resolved = manager.resolveForJob([]);
      assert.deepEqual(resolved, {});
    });
  });

  describe('File I/O', () => {
    test('secrets.json has restrictive permissions (0o600)', () => {
      manager.set('secret', 'value');

      const secretFile = path.join(tmpDir, 'secrets.json');
      const stat = fs.statSync(secretFile);

      // Check mode bits (on Unix-like systems)
      if (process.platform !== 'win32') {
        // 0o600 = rw-------
        const mode = stat.mode & parseInt('777', 8);
        assert.equal(mode, parseInt('600', 8), `Expected 0o600, got 0o${mode.toString(8)}`);
      }
    });

    test('persists secrets across manager instances', () => {
      manager.set('persistent', 'value-1');

      const manager2 = new SecretsManager(tmpDir);
      assert.equal(manager2.get('persistent'), 'value-1');

      manager2.set('persistent', 'value-2');
      const manager3 = new SecretsManager(tmpDir);
      assert.equal(manager3.get('persistent'), 'value-2');
    });
  });

  describe('Encryption isolation', () => {
    test('different hostnames would use different keys (but same in test)', () => {
      manager.set('secret', 'encrypted-value');

      // In real usage, changing hostname changes the key
      // For testing, we just verify the encryption is non-trivial
      const secretFile = path.join(tmpDir, 'secrets.json');
      const stored = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
      const encryptedValue = stored['secret'];

      // Encrypted value should not be plaintext
      assert.notEqual(encryptedValue, 'encrypted-value');
      // Should be base64-encoded
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(encryptedValue));
    });
  });
});
