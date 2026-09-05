import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { readAccountAffinity } from '@/lib/account-affinity';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const clipId = url.searchParams.get('id');
      if (clipId == null) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameter id' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const affinityToken = url.searchParams.get('account_affinity')
        || req.headers.get('x-suno-account-affinity');
      const accountId = readAccountAffinity(affinityToken);
      const tier = accountTier(url.searchParams.get('pool') || req.headers.get('x-suno-pool'));
      const audioInfo = await runSunoRequestWithAffinity(
        (await cookies()).toString(),
        tier,
        accountId,
        (api) => api.getClip(clipId),
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      return compatRouteError('clip', error, corsHeaders);
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
