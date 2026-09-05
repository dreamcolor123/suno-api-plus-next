import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/admin-auth';
import {
  generateApiKey,
  getApiKeyStatus,
  loadApiKeySettings,
  saveApiKeySettings,
} from '@/lib/api-key-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await loadApiKeySettings(true);
    return NextResponse.json(getApiKeyStatus());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load API key status' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    if (body.generate === true) {
      apiKey = generateApiKey();
    }
    const saved = await saveApiKeySettings({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      apiKey,
    });
    return NextResponse.json({
      ok: true,
      message: '接口密钥已保存，立即生效（无需重启）。',
      // return plaintext only when newly generated/explicitly set this request
      apiKey: typeof apiKey === 'string' && apiKey && apiKey.toUpperCase() !== 'CLEAR' ? saved.apiKey : undefined,
      status: getApiKeyStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to save API key' }, { status: 500 });
  }
}
