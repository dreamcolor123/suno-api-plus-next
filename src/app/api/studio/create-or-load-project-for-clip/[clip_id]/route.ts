import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

import { addAccountAffinity } from '@/lib/account-affinity-response';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import {
  studioMutationUnknown,
  studioResponse,
  studioRouteContext,
} from '@/lib/studio-route';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(
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
    const { accountId, tier } = studioRouteContext(req);
    const result = await runSunoRequestWithAffinity(
      (await cookies()).toString(),
      tier,
      accountId,
      async (api, account) => addAccountAffinity(
        await api.createOrLoadStudioProjectForClip(clipId),
        account,
      ),
      // create-or-load is a remote mutation.  A timeout is reconciled by the
      // caller and must never be replayed on another account in this request.
      1,
    );
    return studioResponse(result.value, result.affinity);
  } catch (error) {
    const unknown = studioMutationUnknown('project_create', error);
    return compatRouteError('studio_project_create', unknown || error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
