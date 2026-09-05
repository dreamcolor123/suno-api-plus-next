export const CAPTCHA_CHALLENGE_SCHEMA_VERSION = 'suno-hcaptcha-challenge/v1' as const;

export type CaptchaChallengeSource = 'render' | 'network' | 'verified_static' | 'static_fallback';

export type CaptchaChallengeContextV1 = {
  schemaVersion: typeof CAPTCHA_CHALLENGE_SCHEMA_VERSION;
  websiteURL: string;
  websiteKey: string;
  rqdata?: string;
  enterprisePayload?: Record<string, unknown>;
  userAgent: string;
  invisible: boolean;
  source: CaptchaChallengeSource;
};

export type CaptchaChallengeCacheHit = {
  context: CaptchaChallengeContextV1;
  capturedAt: number;
  expiresAt: number;
  ageMs: number;
};

/**
 * Process-local, account-scoped challenge cache.
 *
 * Challenge lifetimes are fixed when captured: reading an entry never extends
 * its expiry.  This prevents a busy installation from keeping one rendered
 * challenge alive indefinitely and prevents a challenge captured with one
 * Suno account/browser context from being reused by another account.
 */
export class CaptchaChallengeCache {
  private readonly entries = new Map<string, {
    context: CaptchaChallengeContextV1;
    capturedAt: number;
    expiresAt: number;
  }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(accountKey: string): CaptchaChallengeCacheHit | null {
    const key = String(accountKey || '').trim();
    if (!key) return null;
    const entry = this.entries.get(key);
    const now = this.now();
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(key);
      return null;
    }
    return {
      context: {
        ...entry.context,
        ...(entry.context.enterprisePayload
          ? { enterprisePayload: { ...entry.context.enterprisePayload } }
          : {}),
      },
      capturedAt: entry.capturedAt,
      expiresAt: entry.expiresAt,
      ageMs: Math.max(0, now - entry.capturedAt),
    };
  }

  set(accountKey: string, context: CaptchaChallengeContextV1): void {
    const key = String(accountKey || '').trim();
    if (!key) return;
    const capturedAt = this.now();
    this.entries.set(key, {
      context: {
        ...context,
        ...(context.enterprisePayload
          ? { enterprisePayload: { ...context.enterprisePayload } }
          : {}),
      },
      capturedAt,
      expiresAt: capturedAt + Math.max(1, this.ttlMs),
    });
  }

  delete(accountKey: string): void {
    this.entries.delete(String(accountKey || '').trim());
  }

  clear(): void {
    this.entries.clear();
  }
}

const MAX_CHALLENGE_VALUE_LENGTH = 16_384;
const SENSITIVE_KEY = /(?:cookie|authorization|bearer|session|secret|password|token)/i;

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_CHALLENGE_VALUE_LENGTH);
}

function safeEnterprisePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  let source: unknown = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) && key.toLowerCase() !== 'rqdata') continue;
    if (typeof raw === 'string') {
      const normalized = boundedString(raw);
      if (normalized) safe[key] = normalized;
    } else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
      safe[key] = raw;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

function normalizeWebsiteURL(value: unknown, fallback = 'https://suno.com/create'): string {
  const candidate = boundedString(value) || fallback;
  try {
    const parsed = new URL(candidate, fallback);
    if (parsed.protocol !== 'https:' || !/(^|\.)suno\.com$/i.test(parsed.hostname)) return fallback;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function parseBody(postData?: string | null): Record<string, unknown> {
  const text = boundedString(postData);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  try {
    return Object.fromEntries(new URLSearchParams(text).entries());
  } catch {
    return {};
  }
}

function requestLooksLikeHCaptcha(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'hcaptcha.com'
    || host.endsWith('.hcaptcha.com')
    || (host.endsWith('.suno.com') && /hcaptcha|captcha/i.test(`${host}${url.pathname}`));
}

function sitekeyFromRequest(url: URL, body: Record<string, unknown>): string | undefined {
  const direct = boundedString(body.sitekey)
    || boundedString(body.websiteKey)
    || boundedString(body.k)
    || boundedString(url.searchParams.get('sitekey'))
    || boundedString(url.searchParams.get('k'));
  if (direct) return direct;
  const match = url.pathname.match(/\/(?:getcaptcha|checkcaptcha)\/([^/?]+)/i);
  return boundedString(match?.[1]);
}

export function captchaChallengeFromRender(
  renderOptions: unknown,
  websiteURL: string,
  userAgent: string,
): CaptchaChallengeContextV1 | null {
  if (!renderOptions || typeof renderOptions !== 'object') return null;
  const options = renderOptions as Record<string, unknown>;
  const enterprisePayload = safeEnterprisePayload(
    options.enterprisePayload || options.enterprise_payload || options.enterprise,
  );
  const websiteKey = boundedString(options.sitekey || options.websiteKey);
  if (!websiteKey) return null;
  const rqdata = boundedString(options.rqdata)
    || boundedString(options.data)
    || boundedString(enterprisePayload?.rqdata);
  const normalizedEnterprise = enterprisePayload || (rqdata ? { rqdata } : undefined);
  return {
    schemaVersion: CAPTCHA_CHALLENGE_SCHEMA_VERSION,
    websiteURL: normalizeWebsiteURL(websiteURL),
    websiteKey,
    ...(rqdata ? { rqdata } : {}),
    ...(normalizedEnterprise ? { enterprisePayload: normalizedEnterprise } : {}),
    userAgent: boundedString(userAgent) || '',
    invisible: options.invisible !== false && options.size !== 'normal',
    source: 'render',
  };
}

export function captchaChallengeFromRequest(
  requestURL: string,
  postData: string | null | undefined,
  websiteURL: string,
  userAgent: string,
): CaptchaChallengeContextV1 | null {
  let url: URL;
  try {
    url = new URL(requestURL);
  } catch {
    return null;
  }
  if (!requestLooksLikeHCaptcha(url)) return null;
  const body = parseBody(postData);
  const websiteKey = sitekeyFromRequest(url, body);
  if (!websiteKey) return null;
  const enterprisePayload = safeEnterprisePayload(
    body.enterprisePayload || body.enterprise_payload || body.enterprise,
  );
  const rqdata = boundedString(body.rqdata)
    || boundedString(body.data)
    || boundedString(url.searchParams.get('rqdata'))
    || boundedString(enterprisePayload?.rqdata);
  const normalizedEnterprise = enterprisePayload || (rqdata ? { rqdata } : undefined);
  return {
    schemaVersion: CAPTCHA_CHALLENGE_SCHEMA_VERSION,
    websiteURL: normalizeWebsiteURL(websiteURL),
    websiteKey,
    ...(rqdata ? { rqdata } : {}),
    ...(normalizedEnterprise ? { enterprisePayload: normalizedEnterprise } : {}),
    userAgent: boundedString(userAgent) || '',
    invisible: String(body.invisible ?? url.searchParams.get('invisible') ?? '1') !== '0',
    source: 'network',
  };
}

export function staticCaptchaChallenge(
  websiteKey: string,
  websiteURL: string,
  userAgent: string,
): CaptchaChallengeContextV1 {
  return {
    schemaVersion: CAPTCHA_CHALLENGE_SCHEMA_VERSION,
    websiteURL: normalizeWebsiteURL(websiteURL),
    websiteKey: boundedString(websiteKey) || '',
    userAgent: boundedString(userAgent) || '',
    invisible: true,
    source: 'static_fallback',
  };
}

/**
 * Suno generation CAPTCHA version 1 was verified against the live browser
 * widget: fixed website key, invisible mode, and no rqdata/enterprise input.
 * Keep this distinct from a blind fallback so diagnostics can prove why a
 * browser was not launched for every song.
 */
export function verifiedStaticCaptchaChallenge(
  websiteKey: string,
  websiteURL: string,
  userAgent: string,
): CaptchaChallengeContextV1 {
  return {
    ...staticCaptchaChallenge(websiteKey, websiteURL, userAgent),
    source: 'verified_static',
  };
}

export function mergeCaptchaChallenges(
  current: CaptchaChallengeContextV1 | null,
  next: CaptchaChallengeContextV1 | null,
): CaptchaChallengeContextV1 | null {
  if (!next) return current;
  if (!current) return next;
  const preferNext = next.source === 'network' || current.source === 'static_fallback';
  const primary = preferNext ? next : current;
  const secondary = preferNext ? current : next;
  const rqdata = primary.rqdata || secondary.rqdata;
  const enterprisePayload = primary.enterprisePayload || secondary.enterprisePayload;
  return {
    ...primary,
    websiteURL: primary.websiteURL || secondary.websiteURL,
    websiteKey: primary.websiteKey || secondary.websiteKey,
    userAgent: primary.userAgent || secondary.userAgent,
    ...(rqdata ? { rqdata } : {}),
    ...(enterprisePayload ? { enterprisePayload } : {}),
  };
}

export function captchaChallengeSummary(context: CaptchaChallengeContextV1) {
  return {
    schemaVersion: context.schemaVersion,
    source: context.source,
    hasRqdata: Boolean(context.rqdata),
    hasEnterprisePayload: Boolean(context.enterprisePayload),
    invisible: context.invisible,
  };
}
