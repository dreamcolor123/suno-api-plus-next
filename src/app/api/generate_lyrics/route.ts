import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { runSunoRequest } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Generate lyrics through Suno's native endpoint without parent-project code. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'prompt is required.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const tier = accountTier(body?.pool || req.headers.get('x-suno-pool'));
    const requestCookie = (await cookies()).toString();
    const result = await withGenerationConcurrency(() => runSunoRequest(
      requestCookie,
      tier,
      (api) => api.generateLyrics(prompt),
      1,
    ));
    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return compatRouteError('generate_lyrics', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
