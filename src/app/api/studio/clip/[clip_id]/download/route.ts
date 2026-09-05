import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

import { addAccountAffinity } from '@/lib/account-affinity-response';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { studioResponse, studioRouteContext } from '@/lib/studio-route';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(
  req: NextRequest,
  context: { params: { clip_id: string } },
) {
  try {
    const clipId = String(context.params.clip_id || '').trim();
    if (!CLIP_ID_PATTERN.test(clipId)) {
      return studioResponse(
        { error: { code: 'invalid_clip_id', message: 'clip_id is invalid.' } },
        undefined,
        400,
      );
    }
    const url = new URL(req.url);
    const requestedFormat = String(url.searchParams.get('format') || 'wav').trim().toLowerCase();
    const format = requestedFormat === 'mp3' || requestedFormat === 'm4a' ? requestedFormat : 'wav';
    const { accountId, tier } = studioRouteContext(req);
    const result = await runSunoRequestWithAffinity(
      (await cookies()).toString(),
      tier,
      accountId,
      async (api, account) => addAccountAffinity(
        await api.getStudioClipDownloadStatus(clipId, format),
        account,
      ),
      1,
    );
    const status = result.value.status === 'processing' ? 202 : 200;
    return studioResponse(
      result.value,
      result.affinity,
      status,
      result.value.status === 'processing'
        ? { 'Retry-After': String(result.value.retry_after_seconds || 2) }
        : {},
    );
  } catch (error) {
    return compatRouteError('studio_clip_download', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
