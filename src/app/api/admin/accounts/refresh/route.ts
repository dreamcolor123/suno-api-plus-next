import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { getAccountPool } from '@/lib/account-pool';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  let id: string | undefined;
  try {
    const body = await request.json();
    id = body?.id ? String(body.id) : undefined;
  } catch {
    id = undefined;
  }

  const fetchQuota = async (cookie: string) => (await sunoApi(cookie)).get_credits();
  try {
    if (id) {
      return NextResponse.json({ account: await getAccountPool().refreshOne(id, fetchQuota) });
    }
    const result = await getAccountPool().refreshAll(fetchQuota);
    return NextResponse.json({ ...result, accounts: await getAccountPool().list() });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to refresh account quota.' }, { status: 502 });
  }
}
