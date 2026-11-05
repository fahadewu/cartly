import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../config.js';

// Gateway credentials are stored encrypted (AES-256-GCM), so a database dump or backup doesn't leak
// them. The key comes from PAYMENT_SECRETS_KEY in backend/.env and never reaches the database.
let key: Buffer | undefined;

export const secretsKeySet = () => env.paymentSecretsKey.length >= 16;

function cipherKey() {
  if (!secretsKeySet()) throw new Error('PAYMENT_SECRETS_KEY is missing or shorter than 16 characters.');
  return (key ??= scryptSync(env.paymentSecretsKey, 'cartly-payment-gateways', 32));
}

export function seal(data: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map((x) => (typeof x === 'string' ? x : x.toString('base64'))).join(':');
}

export function unseal(sealed: string): Record<string, string> {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== 'v1') throw new Error('Unknown credentials format.');
  const decipher = createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
}
