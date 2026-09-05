import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/admin-auth';
import { getCaptchaStatus } from '@/lib/yescaptcha';
import { loadCaptchaSettings, saveCaptchaSettings } from '@/lib/captcha-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await loadCaptchaSettings(true);
    const status = await getCaptchaStatus();
    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load captcha status' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const saved = await saveCaptchaSettings({
      provider: body.provider,
      yescaptchaKey: body.yescaptchaKey,
      twocaptchaKey: body.twocaptchaKey,
      yescaptchaBaseUrl: body.yescaptchaBaseUrl,
      captchaMode: body.captchaMode,
    });
    const status = await getCaptchaStatus();
    return NextResponse.json({
      ok: true,
      message: '验证码配置已保存，立即生效（无需重启）。',
      settings: {
        provider: saved.provider,
        captchaMode: saved.captchaMode,
        yescaptchaBaseUrl: saved.yescaptchaBaseUrl,
        updatedAt: saved.updatedAt,
        yescaptchaConfigured: Boolean(saved.yescaptchaKey),
        twocaptchaConfigured: Boolean(saved.twocaptchaKey),
      },
      status,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to save captcha settings' }, { status: 500 });
  }
}
