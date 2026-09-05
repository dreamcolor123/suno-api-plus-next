import { promises as fs } from 'fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino();

export type CaptchaProviderSetting = 'yescaptcha' | '2captcha' | 'auto';
export type CaptchaModeSetting = 'auto' | 'token' | 'click';

export type CaptchaSettings = {
  provider: CaptchaProviderSetting;
  yescaptchaKey: string;
  twocaptchaKey: string;
  yescaptchaBaseUrl: string;
  captchaMode: CaptchaModeSetting;
  updatedAt?: string;
};

const DEFAULTS: CaptchaSettings = {
  provider: 'auto',
  yescaptchaKey: '',
  twocaptchaKey: '',
  yescaptchaBaseUrl: 'https://api.yescaptcha.com',
  captchaMode: 'auto',
};

function settingsPath() {
  const dataPath = process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json');
  return path.join(path.dirname(dataPath), 'captcha-settings.json');
}

function fromEnv(): CaptchaSettings {
  const rawProvider = (process.env.CAPTCHA_PROVIDER || 'auto').trim().toLowerCase();
  let provider: CaptchaProviderSetting = 'auto';
  if (rawProvider === 'yescaptcha' || rawProvider === 'yes') provider = 'yescaptcha';
  else if (rawProvider === '2captcha' || rawProvider === 'twocaptcha') provider = '2captcha';
  else provider = 'auto';

  const rawMode = (process.env.CAPTCHA_MODE || 'auto').trim().toLowerCase();
  const captchaMode: CaptchaModeSetting =
    rawMode === 'token' || rawMode === 'click' ? rawMode : 'auto';

  return {
    provider,
    yescaptchaKey: (process.env.YESCAPTCHA_KEY || process.env.YES_CAPTCHA_KEY || '').trim(),
    twocaptchaKey: (process.env.TWOCAPTCHA_KEY || '').trim(),
    yescaptchaBaseUrl: (
      process.env.YESCAPTCHA_BASE_URL ||
      process.env.YES_CAPTCHA_BASE_URL ||
      'https://api.yescaptcha.com'
    ).replace(/\/$/, ''),
    captchaMode,
  };
}

function applyToProcessEnv(settings: CaptchaSettings) {
  process.env.CAPTCHA_PROVIDER = settings.provider;
  process.env.YESCAPTCHA_KEY = settings.yescaptchaKey || '';
  process.env.YES_CAPTCHA_KEY = settings.yescaptchaKey || '';
  process.env.TWOCAPTCHA_KEY = settings.twocaptchaKey || '';
  process.env.YESCAPTCHA_BASE_URL = settings.yescaptchaBaseUrl || 'https://api.yescaptcha.com';
  process.env.CAPTCHA_MODE = settings.captchaMode || 'auto';
}

let cached: CaptchaSettings | null = null;
let loaded = false;

export async function loadCaptchaSettings(force = false): Promise<CaptchaSettings> {
  if (loaded && cached && !force) return cached;
  const envSettings = fromEnv();
  let fileSettings: Partial<CaptchaSettings> = {};
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    fileSettings = JSON.parse(raw);
  } catch {
    // no file yet
  }
  const merged: CaptchaSettings = {
    provider: (fileSettings.provider as CaptchaProviderSetting) || envSettings.provider || 'auto',
    yescaptchaKey:
      typeof fileSettings.yescaptchaKey === 'string' && fileSettings.yescaptchaKey.length
        ? fileSettings.yescaptchaKey
        : envSettings.yescaptchaKey,
    twocaptchaKey:
      typeof fileSettings.twocaptchaKey === 'string' && fileSettings.twocaptchaKey.length
        ? fileSettings.twocaptchaKey
        : envSettings.twocaptchaKey,
    yescaptchaBaseUrl: (
      fileSettings.yescaptchaBaseUrl ||
      envSettings.yescaptchaBaseUrl ||
      'https://api.yescaptcha.com'
    ).replace(/\/$/, ''),
    captchaMode: (fileSettings.captchaMode as CaptchaModeSetting) || envSettings.captchaMode || 'auto',
    updatedAt: fileSettings.updatedAt,
  };
  // If file has empty strings intentionally after admin clear, honor explicit empty only when key present in file
  if (fileSettings && Object.prototype.hasOwnProperty.call(fileSettings, 'yescaptchaKey')) {
    merged.yescaptchaKey = String(fileSettings.yescaptchaKey || '');
  }
  if (fileSettings && Object.prototype.hasOwnProperty.call(fileSettings, 'twocaptchaKey')) {
    merged.twocaptchaKey = String(fileSettings.twocaptchaKey || '');
  }
  applyToProcessEnv(merged);
  cached = merged;
  loaded = true;
  return merged;
}

export function getCaptchaSettingsSync(): CaptchaSettings {
  if (cached) return cached;
  const envSettings = fromEnv();
  applyToProcessEnv(envSettings);
  cached = envSettings;
  return envSettings;
}

export async function saveCaptchaSettings(input: Partial<CaptchaSettings>): Promise<CaptchaSettings> {
  const current = await loadCaptchaSettings(true);
  const next: CaptchaSettings = {
    provider:
      input.provider === 'yescaptcha' || input.provider === '2captcha' || input.provider === 'auto'
        ? input.provider
        : current.provider,
    yescaptchaKey:
      typeof input.yescaptchaKey === 'string' ? input.yescaptchaKey.trim() : current.yescaptchaKey,
    twocaptchaKey:
      typeof input.twocaptchaKey === 'string' ? input.twocaptchaKey.trim() : current.twocaptchaKey,
    yescaptchaBaseUrl: (
      typeof input.yescaptchaBaseUrl === 'string' && input.yescaptchaBaseUrl.trim()
        ? input.yescaptchaBaseUrl.trim()
        : current.yescaptchaBaseUrl || 'https://api.yescaptcha.com'
    ).replace(/\/$/, ''),
    captchaMode:
      input.captchaMode === 'token' || input.captchaMode === 'click' || input.captchaMode === 'auto'
        ? input.captchaMode
        : current.captchaMode,
    updatedAt: new Date().toISOString(),
  };

  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  applyToProcessEnv(next);
  cached = next;
  loaded = true;
  logger.info({ provider: next.provider, file }, 'Captcha settings saved');
  return next;
}

export function maskSecret(value?: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
