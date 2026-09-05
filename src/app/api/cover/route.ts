import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readAccountAffinity } from '@/lib/account-affinity';
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { DEFAULT_MODEL, runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';
import { voiceSelectionFromBody } from '@/lib/voice';

export const maxDuration = 240;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clipId = String(body.clip_id || '').trim();
    if (!clipId) {
      return new NextResponse(JSON.stringify({ error: 'clip_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const affinityToken = body.account_affinity || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const sourceUpload = body.source_upload === true
      || /^(?:1|true|yes|on)$/i.test(String(body.source_upload || ''));
    if (sourceUpload && !accountId) {
      return NextResponse.json({
        error: {
          message: 'account_affinity is required when Cover uses an uploaded source clip.',
          type: 'invalid_request_error',
          code: 'account_affinity_required_for_uploaded_source',
          submission_state: 'not_submitted',
        },
      }, { status: 422, headers: corsHeaders });
    }
    const requestCookie = (await cookies()).toString();
    const tier = accountTier(body.pool || req.headers.get('x-suno-pool'));
    const tags = String(body.tags || body.style_prompt || '');
    const prompt = String(body.lyrics || body.prompt || '');
    const voice = voiceSelectionFromBody(body);

    const audioInfo = await withGenerationConcurrency(() => runSunoRequestWithAffinity(
      requestCookie,
      tier,
      accountId,
      async (api, account) => addAccountAffinity(await api.cover(
          clipId,
          tags,
          String(body.title || 'Cover'),
          prompt,
          body.model || DEFAULT_MODEL,
          voice ? undefined : body.persona_id,
          voice ? undefined : body.persona_model,
          Boolean(body.wait_audio),
          body.negative_tags,
          voice,
        ), account),
      3,
    ));

    return new NextResponse(JSON.stringify(audioInfo.value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...affinityResponseHeaders(audioInfo.affinity),
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return compatRouteError('cover', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
