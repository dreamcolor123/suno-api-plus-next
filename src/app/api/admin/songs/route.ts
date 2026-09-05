import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { sunoApi, withSunoAccountAffinity } from '@/lib/SunoApi';
import { getAccountPool } from '@/lib/account-pool';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const ids = url.searchParams.get('ids');
    const page = url.searchParams.get('page');
    const accountId = url.searchParams.get('account_id');
    if (!(await getAccountPool().hasStoredAccounts()) && !process.env.SUNO_COOKIE) {
      return NextResponse.json([]);
    }
    const requestedIds = ids ? ids.split(',') : undefined;
    const songs = accountId
      ? await withSunoAccountAffinity('basic', accountId, (api) => api.get(requestedIds, page))
      : await (await sunoApi()).get(requestedIds, page);
    return NextResponse.json(songs);
  } catch (error: any) {
    console.error('Admin songs error:', error);
    return NextResponse.json({ error: error?.message || 'Unable to fetch songs.' }, { status: 502 });
  }
}
