import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, cost, saltHex, hashHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || cost !== '16384' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function keyFromEnv(name) {
  const value = process.env[name] || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be 64 hexadecimal characters`);
  return Buffer.from(value, 'hex');
}

export function hashNationalId(value) {
  const normalized = String(value || '').replace(/\D/g, '');
  return createHmac('sha256', keyFromEnv('DATA_LOOKUP_KEY')).update(`national-id:${normalized}`).digest('hex');
}

export function encryptNationalId(value) {
  const normalized = String(value || '').replace(/\D/g, '');
  if (!normalized) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv('DATA_ENCRYPTION_KEY'), iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptNationalId(encoded) {
  if (!encoded) return '';
  const [version, ivHex, tagHex, ciphertextHex] = String(encoded).split('.');
  if (version !== 'v1' || !ivHex || !tagHex || !ciphertextHex) throw new Error('invalid_encrypted_identifier');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv('DATA_ENCRYPTION_KEY'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}
