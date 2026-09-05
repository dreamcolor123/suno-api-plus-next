import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

import { addAccountAffinity } from '@/lib/account-affinity-response';
import { compatRouteError } from '@/lib/compat-route-error';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { studioResponse, studioRouteContext } from '@/lib/studio-route';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(
  req: NextRequest,
  context: { params: { project_id: string } },
) {
  try {
    const projectId = String(context.params.project_id || '').trim();
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return studioResponse(
        { error: { code: 'invalid_project_id', message: 'project_id is invalid.' } },
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
        await api.getStudioProject(projectId),
        account,
      ),
      1,
    );
    return studioResponse(result.value, result.affinity);
  } catch (error) {
    return compatRouteError('studio_project_get', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
