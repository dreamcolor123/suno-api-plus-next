import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { readAccountAffinity } from '@/lib/account-affinity';
import { addAccountAffinity, affinityResponseHeaders } from '@/lib/account-affinity-response';
import { accountTier } from '@/lib/account-pool';
import {
  normalizeAdvancedStemNames,
} from '@/lib/advanced-stems';
import { compatRouteError } from '@/lib/compat-route-error';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function response(value: unknown, affinity?: string) {
  return new NextResponse(JSON.stringify(value), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...affinityResponseHeaders(affinity),
      ...corsHeaders,
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const audioId = String(url.searchParams.get('audio_id') || '').trim();
    if (!audioId) {
      return NextResponse.json(
        { error: { code: 'invalid_clip_id', message: 'audio_id is required.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const affinityToken = url.searchParams.get('account_affinity')
      || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const tier = accountTier(url.searchParams.get('pool') || req.headers.get('x-suno-pool'));
    const result = await runSunoRequestWithAffinity(
      (await cookies()).toString(),
      tier,
      accountId,
      async (api, account) => addAccountAffinity(await api.listAdvancedStems(audioId), account),
      accountId ? 1 : 100,
    );
    return response(result.value, result.affinity);
  } catch (error) {
    return compatRouteError('advanced_stems_list', error, corsHeaders);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const audioId = String(body.audio_id || '').trim();
    if (!audioId) {
      return NextResponse.json(
        { error: { code: 'invalid_clip_id', message: 'audio_id is required.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json(
        { error: { code: 'invalid_project_id', message: 'project_id is required.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    let rawStemNames: unknown[];
    if (body.stem_name !== undefined) {
      rawStemNames = [body.stem_name];
    } else if (Array.isArray(body.stem_names) && body.stem_names.length === 1) {
      // ``stem_names`` is retained only as a compatibility alias.  Validate
      // its wire length before catalogue normalization so a duplicated pair
      // such as ["Bass", "Bass"] cannot be collapsed into one mutation.
      rawStemNames = body.stem_names;
    } else {
      return NextResponse.json(
        { error: { code: 'invalid_stem_selection', message: 'Exactly one stem is required per request.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const stemNames = normalizeAdvancedStemNames(rawStemNames);
    if (stemNames.length !== 1) {
      return NextResponse.json(
        { error: { code: 'invalid_stem_selection', message: 'Exactly one stem is required per request.' } },
        { status: 400, headers: corsHeaders },
      );
    }
    const affinityToken = body.account_affinity || req.headers.get('x-suno-account-affinity');
    const accountId = readAccountAffinity(affinityToken);
    const tier = accountTier(body.pool || req.headers.get('x-suno-pool'));
    const requestCookie = (await cookies()).toString();
    const result = await withGenerationConcurrency(() => runSunoRequestWithAffinity(
      requestCookie,
      tier,
      accountId,
      async (api, account) => addAccountAffinity(
        await api.generateAdvancedStems(audioId, projectId, stemNames[0]),
        account,
      ),
      // An ambiguous extraction response must be reconciled, never retried on
      // another account inside the same HTTP request.
      1,
    ));
    return response(result.value, result.affinity);
  } catch (error) {
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return compatRouteError('advanced_stems_generate', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
