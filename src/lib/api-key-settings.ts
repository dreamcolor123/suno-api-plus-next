import { promises as fs } from 'fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ApiKeySettings = {
  enabled: boolean;
  apiKey: string;
  updatedAt?: string;
};

const DEFAULTS: ApiKeySettings = {
  enabled: false,
  apiKey: '',
};

function settingsPath() {
  const dataPath = process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json');
  return path.join(path.dirname(dataPath), 'api-key-settings.json');
}

function fromEnv(): ApiKeySettings {
  const key = (process.env.SUNO_API_KEY || process.env.API_KEY || '').trim();
  return {
    enabled: Boolean(key) || String(process.env.API_KEY_ENABLED || '').toLowerCase() === 'true',
    apiKey: key,
  };
}

function applyToProcessEnv(settings: ApiKeySettings) {
  process.env.SUNO_API_KEY = settings.apiKey || '';
  process.env.API_KEY = settings.apiKey || '';
  process.env.API_KEY_ENABLED = settings.enabled ? 'true' : 'false';
}

let cached: ApiKeySettings | null = null;
let loaded = false;

export function maskSecret(value?: string | null): string | null {
  if (!value) return null;
  if (value.length <= 10) return '****';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export async function loadApiKeySettings(force = false): Promise<ApiKeySettings> {
  if (loaded && cached && !force) return cached;
  const envSettings = fromEnv();
  let fileSettings: Partial<ApiKeySettings> = {};
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    fileSettings = JSON.parse(raw);
  } catch {
    // no file
  }
  const merged: ApiKeySettings = {
    enabled:
      typeof fileSettings.enabled === 'boolean'
        ? fileSettings.enabled
        : envSettings.enabled,
    apiKey:
      typeof fileSettings.apiKey === 'string'
        ? fileSettings.apiKey
        : envSettings.apiKey,
    updatedAt: fileSettings.updatedAt,
  };
  // empty file key intentionally clears only if property exists
  if (fileSettings && Object.prototype.hasOwnProperty.call(fileSettings, 'apiKey')) {
    merged.apiKey = String(fileSettings.apiKey || '');
  }
  if (fileSettings && Object.prototype.hasOwnProperty.call(fileSettings, 'enabled')) {
    merged.enabled = Boolean(fileSettings.enabled);
  }
  applyToProcessEnv(merged);
  cached = merged;
  loaded = true;
  return merged;
}

export function getApiKeySettingsSync(): ApiKeySettings {
  if (cached) return cached;
  const envSettings = fromEnv();
  applyToProcessEnv(envSettings);
  cached = envSettings;
  return envSettings;
}

export async function saveApiKeySettings(input: Partial<ApiKeySettings>): Promise<ApiKeySettings> {
  const current = await loadApiKeySettings(true);
  const next: ApiKeySettings = {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : current.apiKey,
    updatedAt: new Date().toISOString(),
  };
  if (typeof input.apiKey === 'string' && input.apiKey.trim().toUpperCase() === 'CLEAR') {
    next.apiKey = '';
    next.enabled = false;
  }
  // auto-enable when a new non-empty key is saved
  if (typeof input.apiKey === 'string' && next.apiKey && input.enabled === undefined) {
    next.enabled = true;
  }
  if (next.enabled && !next.apiKey) {
    throw new Error('启用鉴权前请先设置 API Key。');
  }
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  applyToProcessEnv(next);
  cached = next;
  loaded = true;
  return next;
}

export function generateApiKey(): string {
  return `sk-suno-${crypto.randomBytes(24).toString('hex')}`;
}

export function getApiKeyStatus() {
  const settings = getApiKeySettingsSync();
  return {
    enabled: settings.enabled,
    configured: Boolean(settings.apiKey),
    apiKeyMasked: maskSecret(settings.apiKey),
    updatedAt: settings.updatedAt,
  };
}
