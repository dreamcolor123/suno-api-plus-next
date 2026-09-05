import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readAccountAffinity } from '@/lib/account-affinity';
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clipId = String(body.clip_id || '').trim();
    if (!clipId) {
      return NextResponse.json({ error: 'Clip id is required' }, { status: 400, headers: corsHeaders });
    }
    const affinityToken = body.account_affinity || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const tier = accountTier(body.pool || req.headers.get('x-suno-pool'));
    const requestCookie = (await cookies()).toString();
    const result = await withGenerationConcurrency(() => runSunoRequestWithAffinity(
      requestCookie,
      tier,
      accountId,
      async (api, account) => addAccountAffinity(await api.concatenate(clipId), account),
      1,
    ));
    return new NextResponse(JSON.stringify(result.value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...affinityResponseHeaders(result.affinity),
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return compatRouteError('concat', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
