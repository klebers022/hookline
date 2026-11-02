import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignedContent {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
}

export interface VerifyOptions extends SignedContent {
  signatureHeader: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export function generateEndpointSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('base64');
}

function computeSignature({ secret, id, timestamp, body }: SignedContent) {
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  return createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();
}

// Follows the Standard Webhooks signature scheme.
export function signWebhook(content: SignedContent): string {
  const signature = computeSignature(content).toString('base64');
  return `${SIGNATURE_VERSION},${signature}`;
}

export function verifyWebhook({
  signatureHeader,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  ...content
}: VerifyOptions): boolean {
  if (Math.abs(nowSeconds - content.timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = computeSignature(content);
  return signatureHeader.split(' ').some((candidate) => {
    const [version, encoded] = candidate.split(',');
    if (version !== SIGNATURE_VERSION || !encoded) {
      return false;
    }
    const received = Buffer.from(encoded, 'base64');
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
}
