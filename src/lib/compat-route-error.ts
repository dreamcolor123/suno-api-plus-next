import { NextResponse } from 'next/server';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';
import { SunoPublicError } from '@/lib/SunoApi';

const SENSITIVE_ASSIGNMENT = /(authorization|cookie|api[_-]?key|secret|token|password|rqdata|enterprise[_-]?payload|g[_-]?recaptcha[_-]?response)\s*[:=]\s*[^\s,;]+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const ACCOUNT_POOL_REJECTIONS = new Map<string, number>([
  ['account_pool_busy', 429],
  ['account_pool_credentials_unavailable', 503],
  ['account_pool_unavailable', 503],
  ['account_affinity_busy', 429],
  ['account_affinity_queue_full', 429],
  ['account_affinity_unavailable', 503],
]);

// Next's standalone bundler can load the producer and route handler from
// different chunks.  In that case ``instanceof SunoPublicError`` is false
// even though the error still carries the public contract fields.  Keep the
// structural check deliberately narrow so arbitrary upstream errors are not
// promoted to a trusted pre-submission response.
function isSunoPublicErrorLike(error: any): boolean {
  const code = String(error?.code || '').trim();
  const status = Number(error?.status || 0);
  return (
    (error instanceof SunoPublicError || /^suno_[a-z0-9_]+$/i.test(code))
    && status >= 400
    && status <= 599
  );
}

function safeDiagnosticCodes(error: any): string[] {
  if (!Array.isArray(error?.diagnosticCodes)) return [];
  return Array.from(new Set(
    error.diagnosticCodes
      .map((value: unknown) => String(value || '').trim())
      .filter((value: string) => /^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(value))
      .slice(0, 8),
  ));
}

export function safeCompatErrorMessage(error: any, fallback: string): string {
  const upstream = error?.response?.data?.detail || error?.response?.data?.error;
  const candidate = typeof upstream === 'string'
    ? upstream
    : typeof error?.message === 'string'
      ? error.message
      : fallback;
  return String(candidate)
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(SENSITIVE_ASSIGNMENT, '$1=[redacted]')
    .slice(0, 512);
}

export function compatRouteError(
  operation: string,
  error: any,
  headers: Record<string, string>,
) {
  console.error(`${operation} failed: ${safeCompatErrorMessage(error, `${operation} failed`)}`);
  const limited = concurrencyLimitResponse(error, headers);
  if (limited) return limited;

  // Next's standalone build can place the producer and route in separate
  // chunks. Match the deliberately narrow internal error contract rather than
  // relying on instanceof identity across those bundle boundaries.
  const accountPoolCode = String(error?.code || '').trim();
  const accountPoolStatus = ACCOUNT_POOL_REJECTIONS.get(accountPoolCode);
  if (accountPoolStatus !== undefined && Number(error?.status) === accountPoolStatus) {
    const retryAfter = Math.max(1, Number(error?.retryAfterSeconds) || 5);
    return NextResponse.json(
      {
        error: {
          message: error.message,
          type: accountPoolStatus === 429 ? 'rate_limit_error' : 'service_unavailable_error',
          code: accountPoolCode,
          pool: error.tier,
          retry_after: retryAfter,
          submission_state: 'not_submitted',
        },
      },
      {
        status: accountPoolStatus,
        headers: {
          ...headers,
          'Retry-After': String(retryAfter),
        },
      },
    );
  }

  if (isSunoPublicErrorLike(error)) {
    const retryAfter = Number(error.retryAfterSeconds);
    const code = String(error.code || '').trim();
    // CAPTCHA errors are always emitted before the generation POST.  Infer
    // the state structurally as a final guard for errors crossing a bundle
    // boundary where the class fields may have been partially serialized.
    const submissionState = String(
      error.submissionState || error.submission_state ||
      (code.startsWith('suno_captcha_') ? 'not_submitted' : ''),
    ).trim();
    const diagnosticCodes = safeDiagnosticCodes(error);
    return new NextResponse(JSON.stringify({
      error: {
        code,
        message: error.message,
        ...(submissionState
          ? { submission_state: submissionState }
          : {}),
        ...(typeof error.retryable === 'boolean'
          ? { retryable: error.retryable }
          : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retry_after: Math.ceil(retryAfter) }
          : {}),
        ...(diagnosticCodes.length
          ? { provider_codes: diagnosticCodes }
          : {}),
      },
    }), {
      status: error.status,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { 'Retry-After': String(Math.ceil(retryAfter)) }
          : {}),
      },
    });
  }

  const explicitCode = String(error?.code || '').trim();
  const explicitStatus = Number(error?.status || error?.response?.status || 0);
  if (explicitCode && explicitStatus >= 400 && explicitStatus <= 599) {
    const retryAfter = Number(error?.retryAfterSeconds);
    const body: Record<string, unknown> = {
      error: {
        code: explicitCode,
        message: safeCompatErrorMessage(error, `${operation} failed`),
      },
    };
    const submissionState = String(error?.submissionState || '').trim();
    if (
      submissionState === 'not_submitted'
      || explicitCode.startsWith('account_affinity_')
      || explicitCode.endsWith('_busy')
    ) {
      (body.error as Record<string, unknown>).submission_state = 'not_submitted';
      if (typeof error?.retryable === 'boolean') {
        (body.error as Record<string, unknown>).retryable = error.retryable;
      }
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        (body.error as Record<string, unknown>).retry_after = Math.ceil(retryAfter);
      }
    }
    return NextResponse.json(body, {
      status: explicitStatus,
      headers: {
        ...headers,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { 'Retry-After': String(Math.ceil(retryAfter)) }
          : {}),
      },
    });
  }

  const status = explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus : 500;
  const message = safeCompatErrorMessage(error, `${operation} failed`);
  return new NextResponse(JSON.stringify({ error: String(message) }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
