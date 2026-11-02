import { describe, expect, it } from 'vitest';
import {
  generateEndpointSecret,
  signWebhook,
  verifyWebhook,
} from './signing.js';

const content = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
};

describe('signWebhook', () => {
  it('matches the Standard Webhooks test vector', () => {
    expect(signWebhook(content)).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });
});

describe('verifyWebhook', () => {
  const signed = {
    ...content,
    signatureHeader: signWebhook(content),
    nowSeconds: content.timestamp,
  };

  it('accepts a valid signature', () => {
    expect(verifyWebhook(signed)).toBe(true);
  });

  it('accepts a valid signature among several candidates', () => {
    expect(
      verifyWebhook({
        ...signed,
        signatureHeader: `v1,invalid ${signed.signatureHeader}`,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhook({ ...signed, body: '{"test": 1}' })).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyWebhook({ ...signed, secret: generateEndpointSecret() })).toBe(
      false,
    );
  });

  it('rejects a timestamp outside the tolerance', () => {
    expect(
      verifyWebhook({ ...signed, nowSeconds: content.timestamp + 301 }),
    ).toBe(false);
  });
});
