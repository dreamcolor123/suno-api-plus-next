import crypto from 'node:crypto';

const TOKEN_VERSION = 1;

type AffinityPayload = {
  v: number;
  accountId: string;
};

export class AccountAffinityError extends Error {
  readonly status = 400;

  constructor(message = 'Invalid or expired account affinity token.') {
    super(message);
    this.name = 'AccountAffinityError';
  }
}

function signingKey() {
  const source = process.env.ACCOUNT_ENCRYPTION_KEY || process.env.ADMIN_PASSWORD;
  if (!source) throw new Error('ACCOUNT_ENCRYPTION_KEY is not configured.');
  return crypto.createHash('sha256').update(`suno-account-affinity:${source}`).digest();
}

function signature(encodedPayload: string) {
  return crypto.createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
}

export function createAccountAffinity(accountId: string): string {
  const normalized = String(accountId || '').trim();
  if (!normalized) throw new Error('Cannot create affinity token without an account id.');
  const payload: AffinityPayload = { v: TOKEN_VERSION, accountId: normalized };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function readAccountAffinity(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AccountAffinityError();
  const [encoded, suppliedSignature, extra] = value.trim().split('.');
  if (!encoded || !suppliedSignature || extra) throw new AccountAffinityError();

  const expectedSignature = signature(encoded);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AccountAffinityError();
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AffinityPayload;
    if (payload.v !== TOKEN_VERSION || typeof payload.accountId !== 'string' || !payload.accountId.trim()) {
      throw new AccountAffinityError();
    }
    return payload.accountId.trim();
  } catch (error) {
    if (error instanceof AccountAffinityError) throw error;
    throw new AccountAffinityError();
  }
}
