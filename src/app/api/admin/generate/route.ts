import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_MODEL, withSunoAccount, sunoApi } from '@/lib/SunoApi';
import { requireAdmin } from '@/lib/admin-auth';
import { accountTier, getAccountPool } from '@/lib/account-pool';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return NextResponse.json({ error: 'A prompt is required.' }, { status: 400 });

    let usedAccountId: string | null = null;
    const songs = await withGenerationConcurrency(() => withSunoAccount(accountTier(body.pool), async (api, account) => {
      usedAccountId = account?.id || null;
      return api.generate(
        prompt,
        Boolean(body.make_instrumental),
        body.model || DEFAULT_MODEL,
        false,
      );
    }));

    // Sync credits immediately after a successful generation.
    try {
      const pool = getAccountPool();
      const fetchQuota = async (cookie: string) => (await sunoApi(cookie)).get_credits();
      if (usedAccountId) await pool.refreshOne(usedAccountId, fetchQuota);
      else await pool.refreshAll(fetchQuota);
    } catch (syncError) {
      console.warn('Quota sync after generate failed:', syncError);
    }

    return NextResponse.json(songs);
  } catch (error: any) {
    console.error('Admin generate error:', error);
    const limited = concurrencyLimitResponse(error);
    if (limited) return limited;
    const status = error?.response?.status || 502;
    return NextResponse.json({ error: error?.response?.data?.detail || error?.message || 'Unable to start generation.' }, { status });
  }
}
