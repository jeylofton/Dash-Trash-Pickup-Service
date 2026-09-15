import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

export function encryptionAvailable() {
  return getKey() !== null;
}

export function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not configured.');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + enc.toString('hex') + ':' + tag.toString('hex');
}

export function decrypt(blob) {
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not configured.');
  const [ivHex, encHex, tagHex] = blob.split(':');
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, 'hex'), { authTagLength: TAG_LEN });
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
}
