import crypto from 'node:crypto';

type Ciphertext = { iv: string; tag: string; ciphertext: string };

function key() {
  const value = process.env.APP_ENCRYPTION_KEY;
  if (!value) throw new Error('APP_ENCRYPTION_KEY is required.');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return buffer;
}

export function encrypt(value: string): Ciphertext {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decrypt(value: Ciphertext): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
