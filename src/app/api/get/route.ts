import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { readAccountAffinity } from '@/lib/account-affinity';
import { accountTier } from '@/lib/account-pool';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';
import { compatRouteError } from '@/lib/compat-route-error';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const songIds = url.searchParams.get('ids');
      const page = url.searchParams.get('page');
      const cookie = (await cookies()).toString();
      const affinityToken = url.searchParams.get('account_affinity')
        || req.headers.get('x-suno-account-affinity');
      const accountId = readAccountAffinity(affinityToken);
      const tier = accountTier(url.searchParams.get('pool') || req.headers.get('x-suno-pool'));

      const idsArray = songIds && songIds.length > 0 ? songIds.split(',') : undefined;
      const audioInfo = await runSunoRequestWithAffinity(
        cookie,
        tier,
        accountId,
        (api) => api.get(idsArray, page),
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      return compatRouteError('get_audio', error, corsHeaders);
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
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
