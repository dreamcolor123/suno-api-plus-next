import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { readAccountAffinity } from '@/lib/account-affinity';
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  context: { params: { clip_id: string } },
) {
  try {
    const clipId = String(context.params.clip_id || '').trim();
    if (!clipId) {
      return NextResponse.json(
        { error: { code: 'invalid_clip_id', message: 'clip_id is required.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const url = new URL(req.url);
    const format = url.searchParams.get('format') === 'm4a' ? 'm4a' : 'mp3';
    const affinityToken = url.searchParams.get('account_affinity')
      || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const tier = accountTier(
      url.searchParams.get('pool') || req.headers.get('x-suno-pool'),
    );
    const result = await runSunoRequestWithAffinity(
      (await cookies()).toString(),
      tier,
      accountId,
      async (api, account) => addAccountAffinity(
        await api.getClipDownloadStatus(clipId, format),
        account,
      ),
      accountId ? 1 : 3,
    );
    return new NextResponse(JSON.stringify(result.value), {
      status: result.value.status === 'processing' ? 202 : 200,
      headers: {
        'Content-Type': 'application/json',
        ...(result.value.status === 'processing'
          ? { 'Retry-After': String(result.value.retry_after_seconds || 2) }
          : {}),
        ...affinityResponseHeaders(result.affinity),
        ...corsHeaders,
      },
    });
  } catch (error) {
    return compatRouteError('clip_download', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
