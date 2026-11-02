import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from './secret-box.js';

const key = randomBytes(32);

describe('secret box', () => {
  it('decrypts what it encrypted', () => {
    expect(decryptSecret(encryptSecret('whsec_abc', key), key)).toBe(
      'whsec_abc',
    );
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret('whsec_abc', key)).not.toBe(
      encryptSecret('whsec_abc', key),
    );
  });

  it('rejects the wrong key', () => {
    const encrypted = encryptSecret('whsec_abc', key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('rejects tampered data', () => {
    const [iv, authTag] = encryptSecret('whsec_abc', key).split('.');
    const tampered = [iv, authTag, Buffer.from('other').toString('base64')];
    expect(() => decryptSecret(tampered.join('.'), key)).toThrow();
  });
});

describe('parseEncryptionKey', () => {
  it('accepts a 32-byte key', () => {
    expect(parseEncryptionKey(key.toString('base64'))).toEqual(key);
  });

  it('rejects a key of any other size', () => {
    expect(() =>
      parseEncryptionKey(randomBytes(16).toString('base64')),
    ).toThrow('32 bytes');
  });
});
