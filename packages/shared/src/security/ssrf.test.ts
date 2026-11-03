import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import {
  assertPublicTarget,
  BlockedTargetError,
  checkWebhookUrl,
  createGuardedLookup,
  isPublicAddress,
} from './ssrf.js';

const strict = { allowPrivateTargets: false };
const relaxed = { allowPrivateTargets: true };

function fakeLookup(answer: LookupAddress[] | Error) {
  return ((
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) => {
    if (answer instanceof Error) {
      callback(answer, []);
    } else {
      callback(null, answer);
    }
  }) as unknown as typeof import('node:dns').lookup;
}

function runLookup(
  answer: LookupAddress[] | Error,
  all: boolean,
): Promise<{ error: NodeJS.ErrnoException | null; result: unknown }> {
  const lookup = createGuardedLookup(fakeLookup(answer));
  return new Promise((resolve) => {
    lookup('example.test', { all }, (error, address, family) =>
      resolve({ error, result: all ? address : { address, family } }),
    );
  });
}

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.215.14',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
  ])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::127.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('checkWebhookUrl', () => {
  it('accepts a public https URL', () => {
    expect(
      checkWebhookUrl('https://hooks.example.com/in', strict).hostname,
    ).toBe('hooks.example.com');
  });

  it.each([
    ['http://hooks.example.com/in', 'https'],
    ['ftp://hooks.example.com/in', 'https'],
    ['https://user:pass@hooks.example.com/in', 'credentials'],
    ['https://127.0.0.1/in', 'non-public'],
    ['https://[::1]/in', 'non-public'],
    ['https://[::ffff:127.0.0.1]/in', 'non-public'],
    ['https://169.254.169.254/latest/meta-data', 'non-public'],
    ['https://2130706433/in', 'non-public'],
    ['https://0x7f.1/in', 'non-public'],
    ['https://10.0.0.1:8443/in', 'non-public'],
  ])('rejects %s', (url, reason) => {
    expect(() => checkWebhookUrl(url, strict)).toThrow(reason);
  });

  it('allows http and private addresses when enabled', () => {
    expect(() =>
      checkWebhookUrl('http://127.0.0.1:4000/hooks', relaxed),
    ).not.toThrow();
  });

  it('rejects other schemes and credentials even when enabled', () => {
    expect(() => checkWebhookUrl('ftp://127.0.0.1/', relaxed)).toThrow(
      BlockedTargetError,
    );
    expect(() => checkWebhookUrl('http://a:b@127.0.0.1/', relaxed)).toThrow(
      'credentials',
    );
  });
});

describe('assertPublicTarget', () => {
  const resolvesTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(addresses.map((address) => ({ address, family: 4 })));

  it('accepts a hostname with only public addresses', async () => {
    await expect(
      assertPublicTarget(
        'https://hooks.example.com/',
        strict,
        resolvesTo('93.184.215.14'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a hostname with any non-public address', async () => {
    await expect(
      assertPublicTarget(
        'https://hooks.example.com/',
        strict,
        resolvesTo('93.184.215.14', '10.0.0.5'),
      ),
    ).rejects.toThrow('non-public');
  });

  it('rejects a hostname that does not resolve', async () => {
    await expect(
      assertPublicTarget('https://missing.example/', strict, () =>
        Promise.reject(new Error('ENOTFOUND')),
      ),
    ).rejects.toThrow('could not be resolved');
  });

  it('skips the DNS check when private targets are allowed', async () => {
    await expect(
      assertPublicTarget('http://localhost:4000/', relaxed, () =>
        Promise.reject(new Error('should not be called')),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('createGuardedLookup', () => {
  const publicAddress = { address: '93.184.215.14', family: 4 };
  const privateAddress = { address: '127.0.0.1', family: 4 };

  it('returns every address when asked for all', async () => {
    const { error, result } = await runLookup([publicAddress], true);

    expect(error).toBeNull();
    expect(result).toEqual([publicAddress]);
  });

  it('returns the first address otherwise', async () => {
    const { error, result } = await runLookup([publicAddress], false);

    expect(error).toBeNull();
    expect(result).toEqual(publicAddress);
  });

  it('blocks an answer with a non-public address', async () => {
    const { error } = await runLookup([publicAddress, privateAddress], true);

    expect(error).toBeInstanceOf(BlockedTargetError);
    expect(error?.code).toBe('SSRF_BLOCKED');
  });

  it('passes DNS errors through', async () => {
    const { error } = await runLookup(new Error('ENOTFOUND'), false);

    expect(error?.message).toBe('ENOTFOUND');
  });
});
