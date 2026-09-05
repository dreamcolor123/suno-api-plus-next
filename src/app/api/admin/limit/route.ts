import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { sunoApi } from '@/lib/SunoApi';
import { getAccountPool } from '@/lib/account-pool';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const accounts = (await getAccountPool().list()).filter((account) => account.enabled);
    if (accounts.length > 0) {
      return NextResponse.json({
        credits_left: accounts.reduce((total, account) => total + (account.creditsLeft || 0), 0),
        period: 'account-pool',
        monthly_limit: accounts.reduce((total, account) => total + (account.monthlyLimit || 0), 0),
        monthly_usage: accounts.reduce((total, account) => total + (account.monthlyUsage || 0), 0),
        account_count: accounts.length,
      });
    }
    if (!process.env.SUNO_COOKIE) {
      return NextResponse.json({ credits_left: null, period: 'not-configured', monthly_limit: null, monthly_usage: null, account_count: 0 });
    }
    return NextResponse.json(await (await sunoApi()).get_credits());
  } catch (error: any) {
    console.error('Admin limit error:', error);
    return NextResponse.json({ error: error?.message || 'Unable to fetch quota.' }, { status: 502 });
  }
}
