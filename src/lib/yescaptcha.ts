import {
  getCaptchaSettingsSync,
  loadCaptchaSettings,
  maskSecret,
} from '@/lib/captcha-settings';
import { getCaptchaCoordinator } from '@/lib/captcha-coordinator';
import { captchaProxyModes } from '@/lib/captcha-provider';

export type CaptchaProvider = 'yescaptcha' | '2captcha' | 'none';

export type CaptchaStatus = {
  provider: CaptchaProvider;
  yescaptchaConfigured: boolean;
  twocaptchaConfigured: boolean;
  yescaptchaKeyMasked: string | null;
  twocaptchaKeyMasked: string | null;
  yescaptchaBaseUrl: string;
  yescaptchaBalance: number | null;
  yescaptchaError: string | null;
};

function maskKey(key?: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function getYesCaptchaKey(): string {
  return (getCaptchaSettingsSync().yescaptchaKey || '').trim();
}

export function getTwoCaptchaKey(): string {
  return (getCaptchaSettingsSync().twocaptchaKey || '').trim();
}

export function getYesCaptchaBaseUrl(): string {
  return (getCaptchaSettingsSync().yescaptchaBaseUrl || 'https://api.yescaptcha.com')
    .replace(/\/$/, '');
}

export function resolveCaptchaProvider(): CaptchaProvider {
  const settings = getCaptchaSettingsSync();
  const raw = (settings.provider || 'auto').toLowerCase();
  if (raw === 'yescaptcha' || raw === 'yes') {
    return settings.yescaptchaKey
      ? 'yescaptcha'
      : settings.twocaptchaKey
        ? '2captcha'
        : 'none';
  }
  if (raw === '2captcha' || raw === 'twocaptcha') {
    return settings.twocaptchaKey
      ? '2captcha'
      : settings.yescaptchaKey
        ? 'yescaptcha'
        : 'none';
  }
  if (settings.yescaptchaKey) return 'yescaptcha';
  if (settings.twocaptchaKey) return '2captcha';
  return 'none';
}

export async function getCaptchaStatus(): Promise<CaptchaStatus & {
  schemaVersion: 'captcha-status/v2';
  captchaMode: string;
  updatedAt?: string;
  providerSetting: string;
  network: ReturnType<typeof captchaProxyModes>;
  coordinator: ReturnType<ReturnType<typeof getCaptchaCoordinator>['snapshot']>;
  providers: Record<string, unknown>;
}> {
  await loadCaptchaSettings(true);
  const settings = getCaptchaSettingsSync();
  const yesKey = getYesCaptchaKey();
  const twoKey = getTwoCaptchaKey();
  const coordinator = getCaptchaCoordinator().snapshot();
  return {
    schemaVersion: 'captcha-status/v2',
    provider: resolveCaptchaProvider(),
    providerSetting: settings.provider,
    captchaMode: settings.captchaMode,
    yescaptchaConfigured: Boolean(yesKey),
    twocaptchaConfigured: Boolean(twoKey),
    yescaptchaKeyMasked: maskSecret(yesKey) || maskKey(yesKey),
    twocaptchaKeyMasked: maskSecret(twoKey) || maskKey(twoKey),
    yescaptchaBaseUrl: getYesCaptchaBaseUrl(),
    // External connectivity is intentionally checked only by the explicit
    // /api/admin/captcha/probe endpoint, never by the 15-second status poll.
    yescaptchaBalance: null,
    yescaptchaError: null,
    network: captchaProxyModes(),
    coordinator,
    providers: {
      yescaptcha: {
        configured: Boolean(yesKey),
        ...(coordinator.providers as any).yescaptcha,
      },
      '2captcha': {
        configured: Boolean(twoKey),
        ...(coordinator.providers as any)['2captcha'],
      },
    },
    updatedAt: settings.updatedAt,
  };
}
