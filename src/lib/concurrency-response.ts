import { NextResponse } from 'next/server';
import { GenerationConcurrencyLimitError } from '@/lib/concurrency-settings';

export function concurrencyLimitResponse(
  error: unknown,
  headers: Record<string, string> = {},
): NextResponse | null {
  const candidate = error as GenerationConcurrencyLimitError | undefined;
  if (
    !(error instanceof GenerationConcurrencyLimitError)
    && !(
      candidate?.code === 'concurrency_limit_exceeded'
      && Number(candidate?.status) === 429
    )
  ) return null;
  const rejection = candidate as GenerationConcurrencyLimitError;

  return NextResponse.json(
    {
      error: {
        message: rejection.message,
        type: 'rate_limit_error',
        code: rejection.code,
        limit: rejection.limit,
        active_requests: rejection.activeRequests,
        retry_after: rejection.retryAfterSeconds,
        submission_state: 'not_submitted',
      },
    },
    {
      status: rejection.status,
      headers: {
        ...headers,
        'Retry-After': String(rejection.retryAfterSeconds),
      },
    },
  );
}
