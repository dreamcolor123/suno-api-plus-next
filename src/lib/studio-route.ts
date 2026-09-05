import { NextRequest, NextResponse } from 'next/server';

import { AccountAffinityError, readAccountAffinity } from '@/lib/account-affinity';
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { accountTier, AccountTier } from '@/lib/account-pool';
import { SunoPublicError } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export type StudioRouteContext = {
  accountId?: string;
  tier: AccountTier;
};

export function studioRouteContext(
  req: NextRequest,
  body?: Record<string, any>,
): StudioRouteContext {
  const url = new URL(req.url);
  const affinityToken = body?.account_affinity
    || url.searchParams.get('account_affinity')
    || req.headers.get('x-suno-account-affinity');
  let accountId: string | undefined;
  try {
    accountId = readAccountAffinity(affinityToken);
  } catch (error) {
    if (error instanceof AccountAffinityError) {
      throw new SunoPublicError(
        'invalid_account_affinity',
        'account_affinity is invalid or expired.',
        400,
      );
    }
    throw error;
  }
  const tier = accountTier(
    body?.pool
    || url.searchParams.get('pool')
    || req.headers.get('x-suno-pool'),
  );
  return { accountId, tier };
}

export function studioResponse(
  value: unknown,
  affinity?: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new NextResponse(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...affinityResponseHeaders(affinity),
      ...extraHeaders,
      ...corsHeaders,
    },
  });
}

export function withStudioAffinity<T>(value: T, account: any) {
  return addAccountAffinity(value, account);
}

/** Convert an indeterminate Studio mutation into a non-replayable contract. */
export function studioMutationUnknown(
  operation: string,
  error: any,
): SunoPublicError | null {
  if (error instanceof SunoPublicError) {
    if (error.submissionState || String(error.code || '').startsWith('account_')) {
      return null;
    }
  }
  const status = Number(error?.response?.status || error?.status || 0);
  if (status > 0 && status < 500) return null;
  const safeOperation = String(operation || 'mutation').replace(/[^a-z0-9_]+/gi, '_');
  return new SunoPublicError(
    `suno_studio_${safeOperation}_submission_unknown`,
    `The Studio ${operation} result is unknown; reconcile the project before retrying.`,
    502,
    { submissionState: 'submission_unknown', retryable: false },
  );
}
