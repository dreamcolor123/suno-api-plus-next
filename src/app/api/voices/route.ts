import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createAccountAffinity, readAccountAffinity } from '@/lib/account-affinity';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';
import { assertPublicVoice, normalizeVoice, normalizeVoiceId, SunoVoice } from '@/lib/voice';

export const dynamic = 'force-dynamic';

function publicVoiceView(voice: SunoVoice) {
  return {
    id: voice.id,
    voice_id: voice.voice_id,
    name: voice.name,
    description: voice.description,
    image_s3_id: voice.image_s3_id,
    persona_type: 'vox',
    is_public: true,
    is_owned: voice.is_owned === true,
    source: voice.source,
  };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const requestedVoiceId = normalizeVoiceId(
      url.searchParams.get('id') || url.searchParams.get('voice_id'),
    );
    if (!requestedVoiceId) {
      const error = new Error('id is required; account-private Voice listing is not supported.');
      (error as Error & { status: number }).status = 400;
      throw error;
    }
    const affinityToken = url.searchParams.get('account_affinity')
      || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const tier = accountTier(url.searchParams.get('pool') || req.headers.get('x-suno-pool'));
    const requestCookie = (await cookies()).toString();

    const response = await runSunoRequestWithAffinity(
      requestCookie,
      tier,
      accountId,
      async (api, account) => {
        const voice = normalizeVoice(await api.getVoice(requestedVoiceId));
        assertPublicVoice(voice);
        return {
          voice: publicVoiceView(voice),
          account_affinity: account ? createAccountAffinity(account.id) : undefined,
        };
      },
    );

    return NextResponse.json(response, {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error: any) {
    return compatRouteError('voices', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
