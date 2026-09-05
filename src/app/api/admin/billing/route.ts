import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/admin-auth';
import {
  BillingSettingsValidationError,
  calculateBillingSummary,
  getBillingSnapshot,
  saveBillingSettings,
} from '@/lib/billing-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await getBillingSnapshot(true));
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to load billing settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const settings = await saveBillingSettings(input);
    return NextResponse.json({
      ok: true,
      message: '计费设置已保存，立即生效（无需重启）。',
      settings,
      summary: calculateBillingSummary(settings),
    });
  } catch (err: any) {
    const status = err instanceof BillingSettingsValidationError ? 400 : 500;
    return NextResponse.json(
      { error: err?.message || 'Failed to save billing settings' },
      { status },
    );
  }
}
