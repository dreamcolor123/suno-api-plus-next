import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { readAccountAffinity } from '@/lib/account-affinity';
import { DEFAULT_MODEL, runSunoRequestWithAffinity } from "@/lib/SunoApi";
import { accountTier } from '@/lib/account-pool';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { compatRouteError } from '@/lib/compat-route-error';
import { corsHeaders } from "@/lib/utils";
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { assertVoiceCanGenerate, voiceSelectionFromBody } from '@/lib/voice';

export const maxDuration = 240;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, tags, title, make_instrumental, model, wait_audio, negative_tags } = body;
      const voice = voiceSelectionFromBody(body, { allowPersonaAlias: true });
      assertVoiceCanGenerate(voice, Boolean(make_instrumental));
      const affinityToken = body.account_affinity || req.headers.get('x-suno-account-affinity');
      const accountId = readAccountAffinity(affinityToken);
      const audioInfo = await withGenerationConcurrency(async () => runSunoRequestWithAffinity(
        (await cookies()).toString(),
        accountTier(body.pool || req.headers.get('x-suno-pool')),
        accountId,
        async (api, account) => addAccountAffinity(await api.custom_generate(
          prompt, tags, title,
          Boolean(make_instrumental),
          model || DEFAULT_MODEL,
          Boolean(wait_audio),
          negative_tags,
          voice,
        ), account),
        3,
      ));
      return new NextResponse(JSON.stringify(audioInfo.value), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...affinityResponseHeaders(audioInfo.affinity),
          ...corsHeaders
        }
      });
    } catch (error: any) {
      return compatRouteError('custom_generate', error, corsHeaders);
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
