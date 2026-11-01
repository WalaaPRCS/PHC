import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, opaqueToken, tokenHash, encryptNationalId, decryptNationalId, hashNationalId } from '../src/security.js';

test('password hashes verify only the original password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.notEqual(stored, 'correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
});

test('session tokens are opaque and only their digest is suitable for storage', () => {
  const token = opaqueToken();
  assert.ok(token.length >= 40);
  assert.notEqual(token, tokenHash(token));
});

test('national identifiers are encrypted at rest and can be matched without plaintext', () => {
  process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.DATA_LOOKUP_KEY = 'b'.repeat(64);
  const encrypted = encryptNationalId('1234567890');
  assert.notEqual(encrypted, '1234567890');
  assert.equal(decryptNationalId(encrypted), '1234567890');
  assert.equal(hashNationalId('1234567890'), hashNationalId('12-34567890'));
  assert.notEqual(hashNationalId('1234567890'), hashNationalId('1234567891'));
});
