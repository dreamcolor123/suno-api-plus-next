import { NextRequest, NextResponse } from 'next/server';
import {
  TwoCaptchaProviderAdapter,
  YesCaptchaProviderAdapter,
  captchaProxyModes,
} from '@/lib/captcha-provider';
import { loadCaptchaSettings } from '@/lib/captcha-settings';
import { getCaptchaCoordinator } from '@/lib/captcha-coordinator';
import { isAdminRequest } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  await loadCaptchaSettings(true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9_000);
  timer.unref?.();
  try {
    const providers = [new YesCaptchaProviderAdapter(), new TwoCaptchaProviderAdapter()];
    const coordinator = getCaptchaCoordinator();
    const rows = await Promise.all(providers.map(async (provider) => {
      const health = await provider.health(controller.signal);
      coordinator.recordProviderHealth(health);
      return [provider.name, {
        configured: health.configured,
        api: {
          state: health.reachable ? 'reachable' : 'unreachable',
          checkedAt: new Date().toISOString(),
          latencyMs: health.latencyMs,
          code: health.code,
        },
      }];
    }));
    return NextResponse.json({
      schemaVersion: 'captcha-provider-probe/v1',
      network: captchaProxyModes(),
      providers: Object.fromEntries(rows),
    });
  } finally {
    clearTimeout(timer);
  }
}
