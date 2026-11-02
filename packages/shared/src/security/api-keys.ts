import { createHash, randomBytes } from 'node:crypto';

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(4).toString('hex');
  const key = `hk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}
