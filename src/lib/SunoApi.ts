import axios, { AxiosInstance, AxiosProxyConfig } from 'axios';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep } from '@/lib/utils';
import * as cookie from 'cookie';
import { createHash, randomUUID } from 'node:crypto';
import { Browser, BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import path from 'node:path';
import {
  AccountTier,
  AccountView,
  AffinityWaitOptions,
  getAccountPool,
} from '@/lib/account-pool';
import { loadCaptchaSettings } from '@/lib/captcha-settings';
import { DEFAULT_SUNO_MODEL, resolveSunoProviderModel } from '@/lib/suno-models';
import {
  applyVoiceToPayload,
  assertPublicVoice,
  normalizeVoice,
  normalizeVoiceId,
  SunoVoice,
  VoiceRequestError,
  VoiceSelection,
} from '@/lib/voice';
import {
  AdvancedStemClip,
  AdvancedStemName,
  classifyAdvancedStemClip,
  normalizeAdvancedStemNames,
  normalizeDownbeats,
} from '@/lib/advanced-stems';
import { packagedChromiumLaunchOptions } from '@/lib/browser-runtime';
import {
  captchaAcquisitionTimeoutMs,
  runWithCaptchaAcquisitionDeadline,
} from '@/lib/captcha-deadline';
import {
  CaptchaChallengeCache,
  CaptchaChallengeContextV1,
  captchaChallengeFromRender,
  captchaChallengeFromRequest,
  captchaChallengeSummary,
  mergeCaptchaChallenges,
  staticCaptchaChallenge,
  verifiedStaticCaptchaChallenge,
} from '@/lib/captcha-challenge';
import {
  abortableCaptchaDelay,
  CaptchaProof,
} from '@/lib/captcha-provider';
import {
  CaptchaCoordinatorSession,
  CaptchaProvidersUnavailableError,
  getCaptchaCoordinator,
} from '@/lib/captcha-coordinator';
import {
  buildSunoBrowserCookies,
  SUNO_CAPTCHA_BROWSER_USER_AGENT,
} from '@/lib/captcha-browser-session';
import {
  ClipDownloadStatus,
  normalizeClipDownloadResponse,
  StudioClipDownloadStatus,
  normalizeStudioClipDownloadResponse,
} from '@/lib/clip-download';

// sunoApi instance caching
const globalForSunoApi = global as unknown as {
  sunoApiCache?: Map<string, SunoApi>;
  captchaChallengeCache?: CaptchaChallengeCache;
};
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const CAPTCHA_CHALLENGE_CACHE_MS = 10 * 60 * 1_000;
const captchaChallengeCache = globalForSunoApi.captchaChallengeCache
  || new CaptchaChallengeCache(CAPTCHA_CHALLENGE_CACHE_MS);
globalForSunoApi.captchaChallengeCache = captchaChallengeCache;

const logger = pino({
  redact: {
    paths: [
      'authorization',
      'cookie',
      'token',
      'clientKey',
      'apiKey',
      'rqdata',
      'enterprisePayload',
      'gRecaptchaResponse',
      'proxy.password',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[redacted]',
  },
});
export const DEFAULT_MODEL = DEFAULT_SUNO_MODEL;

type SunoProxySettings = {
  server: string;
  axios: AxiosProxyConfig;
  username?: string;
  password?: string;
};

function getSunoProxySettings(): SunoProxySettings | undefined {
  const raw = (process.env.SUNO_PROXY_URL || process.env.SUNO_PROXY || '').trim();
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('only http:// and https:// proxies are supported');
    }
    if (!parsed.hostname || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw new Error('the proxy URL must contain only scheme, host, port, and optional credentials');
    }

    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('invalid proxy port');
    }

    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const axiosProxy: AxiosProxyConfig = {
      protocol: parsed.protocol.slice(0, -1),
      host: parsed.hostname,
      port,
    };
    if (username) axiosProxy.auth = { username, password: password || '' };

    return {
      server: `${parsed.protocol}//${parsed.host}`,
      axios: axiosProxy,
      username,
      password,
    };
  } catch (error: any) {
    throw new Error(`Invalid SUNO_PROXY_URL: ${error?.message || String(error)}`);
  }
}

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

export interface UploadedAudioInfo {
  id: string;
  status: string;
  title?: string;
  image_url?: string;
  has_vocal?: boolean;
  inferred_description?: string;
  copyright_muted?: boolean;
  error_type?: string;
  error_message?: string;
  [key: string]: any;
}

export interface InitializedUploadedClipInfo extends UploadedAudioInfo {
  upload_id: string;
  clip_id: string;
}

export interface UploadAudioOptions {
  extension?: string;
  upload_type?: string;
  poll_interval_seconds?: number;
  max_poll_attempts?: number;
}

export type AdvancedStemGeneration = {
  source_clip_id: string;
  project_id: string;
  requested_stems: AdvancedStemName[];
  submissions: Array<{
    stem_name: AdvancedStemName;
    transaction_uuid: string;
    clips: AdvancedStemClip[];
  }>;
  clips: AdvancedStemClip[];
};

export type AdvancedStemListing = {
  source_clip_id: string;
  pages: number;
  clips: AdvancedStemClip[];
};

function providerClipRows(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap((item) => providerClipRows(item));
  if (!value || typeof value !== 'object') return [];
  // Advanced Split responses have appeared both as a flat ``clips`` array
  // and as one ``submissions`` row per requested stem.  Treat the latter as
  // another envelope so nested/camel-case provider responses retain their
  // Clip ids instead of being misclassified as an empty mutation result.
  for (const key of ['clips', 'stem_clips', 'items', 'results', 'submissions', 'data']) {
    const nested = value[key];
    if (Array.isArray(nested)) return providerClipRows(nested);
    if (nested && typeof nested === 'object') {
      const rows = providerClipRows(nested);
      if (rows.length) return rows;
    }
  }
  return value.id || value.clip_id || value.clipId || value.asset?.id ? [value] : [];
}

function advancedStemClip(value: any): AdvancedStemClip | null {
  const id = String(
    value?.id
    || value?.clip_id
    || value?.clipId
    || value?.stem_clip_id
    || value?.stemClipId
    || value?.asset?.id
    || value?.asset?.clip_id
    || value?.asset?.clipId
    || '',
  ).trim();
  if (!id) return null;
  const metadata = value?.metadata && typeof value.metadata === 'object'
    ? { ...value.metadata }
    : {};
  return {
    ...value,
    id,
    title: String(
      value?.title
      || value?.provider_title
      || value?.providerTitle
      || metadata.stem_name
      || metadata.stem_type_group_name
      || '',
    ).trim(),
    provider_title: String(
      value?.provider_title || value?.providerTitle || value?.title || '',
    ).trim(),
    metadata,
  };
}

function advancedStemClips(value: any): AdvancedStemClip[] {
  return providerClipRows(value)
    .map(advancedStemClip)
    .filter((item): item is AdvancedStemClip => item !== null);
}

function providerPageCount(value: any): number | null {
  if (Number.isInteger(Number(value)) && Number(value) >= 0) return Number(value);
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['pages', 'total_pages', 'page_count', 'num_pages', 'count']) {
    const candidate = Number(value[key]);
    if (Number.isInteger(candidate) && candidate >= 0) return candidate;
    if (Array.isArray(value[key])) return value[key].length;
  }
  return null;
}

function providerDownloadUrl(value: any): string {
  if (!value || typeof value !== 'object') return '';
  for (const key of [
    'download_url', 'downloadUrl', 'wav_file_url', 'wavFileUrl',
    'wav_url', 'wavUrl', 'wav_file', 'audio_url', 'audioUrl', 'url',
  ]) {
    const candidate = String(value[key] || '').trim();
    if (/^https:\/\//i.test(candidate)) return candidate;
  }
  for (const key of ['data', 'result', 'file']) {
    const nested = providerDownloadUrl(value[key]);
    if (nested) return nested;
  }
  return '';
}

function providerState(value: any): string {
  return String(value?.state || value?.status || value?.data?.state || value?.data?.status || '')
    .trim()
    .toLowerCase();
}

export interface InitializeUploadedClipMetadata {
  title?: string;
  prompt?: string;
  lyrics?: string;
  image_url?: string;
  user_reviewed_tags?: boolean;
}

/**
 * The description shown in Suno's Song Details editor is not part of the
 * ``set_metadata`` payload.  Suno exposes it through a separate endpoint and
 * calls the value a user-corrected description.  Keep this as a small method
 * on the authenticated API object so callers can update a portable upload
 * while preserving the account affinity that owns the clip.
 */
export interface UploadedClipAudioDescription {
  user_corrected_description: string;
}

export interface UploadedClipDisplayTags {
  display_tags: string;
}

/**
 * Suno's mutation endpoints return HTTP 4xx for a number of ordinary,
 * user-facing validation/moderation failures.  Axios therefore does not
 * expose the useful ``error_type`` through a normal return value.  Keep the
 * provider code on a public, credential-safe error so the API route can
 * report the real reason and decide whether a retry makes sense.
 */
function providerMutationError(
  value: any,
  operation: string,
): SunoPublicError | null {
  if (!value || typeof value !== 'object') {
    return new SunoPublicError(
      `${operation}_empty_response`,
      `Suno returned an empty response while updating ${operation}.`,
      502,
      { retryable: true },
    );
  }
  const rawCode = value.error_type
    || value.error?.code
    || value.error?.type;
  const code = String(rawCode || '').trim();
  if (!code) return null;
  const safeCode = /^[A-Za-z0-9_.-]{1,128}$/.test(code)
    ? code
    : `${operation}_failed`;
  const lowerCode = code.toLowerCase();
  const moderation = lowerCode.includes('moderation');
  const status = Number(value.status || value.status_code || 0);
  const normalizedStatus = status >= 400 && status <= 599
    ? status
    : moderation ? 422
      : lowerCode.includes('rate') ? 429
        : lowerCode.includes('timeout') ? 408
          : 400;
  const retryable = normalizedStatus === 408
    || normalizedStatus === 425
    || normalizedStatus === 429
    || normalizedStatus >= 500;
  return new SunoPublicError(
    safeCode,
    `Suno rejected the ${operation} update (${safeCode}).`,
    normalizedStatus,
    { retryable: !moderation && retryable },
  );
}

function assertProviderMutationSuccess(value: any, operation: string): any {
  const error = providerMutationError(value, operation);
  if (error) throw error;
  return value;
}

export class SunoPublicError extends Error {
  readonly code: string;
  readonly status: number;
  readonly submissionState?: 'not_submitted' | 'submission_unknown';
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly recordAccountFailure?: boolean;
  readonly allowAccountFailover?: boolean;
  readonly diagnosticCodes?: string[];

  constructor(
    code: string,
    message: string,
    status: number,
    options: {
      submissionState?: 'not_submitted' | 'submission_unknown';
      retryable?: boolean;
      retryAfterSeconds?: number;
      recordAccountFailure?: boolean;
      allowAccountFailover?: boolean;
      diagnosticCodes?: string[];
    } = {},
  ) {
    super(message);
    this.name = 'SunoPublicError';
    this.code = code;
    this.status = status;
    this.submissionState = options.submissionState;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.recordAccountFailure = options.recordAccountFailure;
    this.allowAccountFailover = options.allowAccountFailover;
    this.diagnosticCodes = Array.from(new Set(
      (options.diagnosticCodes || [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(value))
        .slice(0, 8),
    ));
  }
}

function captchaWasExplicitlyRejected(error: any): boolean {
  const status = Number(error?.response?.status || 0);
  if (![400, 401, 403, 422].includes(status)) return false;
  const body = error?.response?.data;
  const text = typeof body === 'string'
    ? body
    : JSON.stringify(body || {});
  return /(?:hcaptcha|captcha).{0,120}(?:invalid|expired|incorrect|failed|reject)|(?:invalid|expired).{0,80}(?:hcaptcha|captcha)/i
    .test(text);
}

function postOutcomeIsIndeterminate(error: any): boolean {
  const status = Number(error?.response?.status || 0);
  return !error?.response || status >= 500;
}

function generationResponseWasAccepted(response: any): boolean {
  const clips = response?.data?.clips;
  return Number(response?.status || 0) >= 200
    && Number(response?.status || 0) < 300
    && Array.isArray(clips)
    && clips.some((clip: any) => typeof clip?.id === 'string' && clip.id.trim());
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

export class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private readonly proxy = getSunoProxySettings();
  private accountKey: string;
  private lastCaptchaVersion: number | null = null;
  private cursor?: Cursor;

  constructor(cookies: string, accountKey?: string) {
    this.accountKey = String(accountKey || '').trim()
      || `cookie:${createHash('sha256').update(cookies).digest('hex').slice(0, 24)}`;
    // The old random Macintosh pool mixed Safari, Firefox and Chrome UAs with
    // a Chromium browser and Android Client Hints. hCaptcha binds enough of
    // that fingerprint for the mismatch to make otherwise valid jobs fail.
    this.userAgent = SUNO_CAPTCHA_BROWSER_USER_AGENT;
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    if (this.proxy) logger.info({ proxy: this.proxy.server }, 'Suno outbound proxy enabled');
    this.client = axios.create({
      withCredentials: true,
      proxy: this.proxy?.axios,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'X-Requested-With': 'com.suno.android',
        'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) =>
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public bindAccountKey(accountKey?: string): SunoApi {
    const normalized = String(accountKey || '').trim();
    if (normalized) this.accountKey = normalized;
    return this;
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.

  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /** Refresh and return the current Bearer token for a task-scoped child process. */
  public async getAccessToken(): Promise<string> {
    await this.keepAlive(false);
    if (!this.currentToken) throw new Error('Suno did not return an access token.');
    return this.currentToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    const required = Boolean(resp.data?.required);
    const parsedVersion = Number(resp.data?.captcha_version);
    this.lastCaptchaVersion = Number.isFinite(parsedVersion) ? parsedVersion : null;
    logger.info({ required, captchaVersion: this.lastCaptchaVersion }, 'Checked Suno CAPTCHA requirement');
    return required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position)
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    let browserOptions: { executablePath?: string };
    try {
      browserOptions = packagedChromiumLaunchOptions(process.env);
    } catch (error: any) {
      logger.warn(
        { errorType: error?.constructor?.name || 'Error' },
        'Packaged Chromium validation failed',
      );
      throw new SunoPublicError(
        'suno_captcha_browser_unavailable',
        'The bundled CAPTCHA browser is missing or invalid. Restart or repair Suno Studio, then retry.',
        503,
        {
          submissionState: 'not_submitted',
          retryable: false,
          retryAfterSeconds: 5,
        },
      );
    }
    let browser: Browser;
    try {
      browser = await this.getBrowserType().launch({
        args,
        headless: yn(process.env.BROWSER_HEADLESS, { default: true }),
        proxy: this.proxy
          ? {
              server: this.proxy.server,
              username: this.proxy.username,
              password: this.proxy.password,
            }
          : undefined,
        ...browserOptions,
      });
    } catch (error: any) {
      logger.warn(
        { errorType: error?.constructor?.name || 'Error' },
        'CAPTCHA browser launch failed',
      );
      throw new SunoPublicError(
        browserOptions.executablePath
          ? 'suno_captcha_browser_unavailable'
          : 'suno_captcha_unavailable',
        browserOptions.executablePath
          ? 'The bundled CAPTCHA browser could not start. Restart or repair Suno Studio, then retry.'
          : 'The CAPTCHA browser could not start. Check the CAPTCHA configuration and retry.',
        503,
        {
          submissionState: 'not_submitted',
          retryable: !browserOptions.executablePath,
          retryAfterSeconds: 5,
        },
      );
    }
    const context = await browser.newContext({ userAgent: this.userAgent, locale: process.env.BROWSER_LOCALE, viewport: { width: 1400, height: 900 } });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://suno.com' });
    } catch {}
    await context.addCookies(buildSunoBrowserCookies(this.cookies, String(this.currentToken || '')));
    return context;
  }

  /** Capture the challenge Suno actually rendered; challenge data stays process-local. */
  private async captureCaptchaChallenge(signal: AbortSignal): Promise<CaptchaChallengeContextV1> {
    if (signal.aborted) throw signal.reason || new Error('captcha_cancelled');
    const browser = await this.launchBrowser();
    const abortBrowser = () => { void browser.close().catch(() => undefined); };
    signal.addEventListener('abort', abortBrowser, { once: true });
    const defaultSitekey = (
      process.env.SUNO_HCAPTCHA_SITEKEY
      || 'd65453de-3f1a-4aac-9366-a0f06e52b2ce'
    ).trim();
    let captured: CaptchaChallengeContextV1 | null = null;
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      await page.route('**/api/c/check', async (route: any) => {
        // The API client has already proved that generation needs CAPTCHA.
        // Suno's browser fingerprint can independently report `required=false`;
        // mirror the proven state so the official widget mounts without a
        // speculative generation POST.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ required: true, captcha_version: 1 }),
        });
      });
      await page.route('**/api/generate/**', async (route: any) => {
        // The diagnostic page only exists to obtain Suno's live challenge.
        // Abort before clicking so the synthetic prompt can never create music.
        await route.abort('blockedbyclient');
      });
      await page.addInitScript(() => {
        const state = { renders: [] as Array<Record<string, unknown>> };
        (window as any).__sunoCaptchaChallenge = state;
        const hook = () => {
          const captcha = (window as any).hcaptcha;
          if (!captcha || captcha.__sunoStudioHooked) return;
          captcha.__sunoStudioHooked = true;
          const original = captcha.render?.bind(captcha);
          if (!original) return;
          captcha.render = (element: unknown, options: Record<string, unknown> = {}) => {
            try {
              const enterprise = options.enterprisePayload
                || options.enterprise_payload
                || options.enterprise;
              state.renders.push({
                sitekey: options.sitekey,
                rqdata: options.rqdata || options.data,
                enterprisePayload: enterprise,
                invisible: options.invisible,
                size: options.size,
              });
            } catch {}
            return original(element, options);
          };
        };
        const descriptor = Object.getOwnPropertyDescriptor(window, 'hcaptcha');
        if (!descriptor || descriptor.configurable) {
          let current = (window as any).hcaptcha;
          Object.defineProperty(window, 'hcaptcha', {
            configurable: true,
            get: () => current,
            set: (value) => {
              current = value;
              try { hook(); } catch {}
            },
          });
        }
        const interval = setInterval(hook, 100);
        setTimeout(() => clearInterval(interval), 70_000);
      });
      page.on('request', (request) => {
        try {
          captured = mergeCaptchaChallenges(
            captured,
            captchaChallengeFromRequest(
              request.url(),
              request.postData(),
              page?.url() || 'https://suno.com/create',
              this.userAgent || '',
            ),
          );
        } catch {}
      });
      await page.goto('https://suno.com/create', {
        referer: 'https://www.google.com/',
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });
      const actualUserAgent = await page.evaluate(() => navigator.userAgent).catch(() => this.userAgent || '');
      this.userAgent = actualUserAgent || this.userAgent;
      await this.dismissOverlays(page);
      try {
        const simpleTab = page.getByRole('tab', { name: /^Simple$/i }).first();
        if (await simpleTab.count()) await simpleTab.click({ force: true, timeout: 2_000 });
      } catch {}
      try {
        const promptBox = await this.findPromptInput(page);
        await this.forceFillPrompt(page, promptBox, 'Lorem ipsum city lights night');
        const button = await this.findCreateButton(page);
        await button.click({ force: true, timeout: 5_000 }).catch(() => button.evaluate((element: HTMLElement) => {
          element.removeAttribute('disabled');
          (element as HTMLButtonElement).disabled = false;
          element.click();
        }));
      } catch (error: any) {
        logger.info({ errorType: error?.constructor?.name || 'Error' }, 'CAPTCHA challenge UI probe did not complete');
      }

      const captureBudgetMs = Math.max(
        5_000,
        Math.min(30_000, Number(process.env.CAPTCHA_CHALLENGE_CAPTURE_MS) || 25_000),
      );
      const started = Date.now();
      while (Date.now() - started < captureBudgetMs && !signal.aborted) {
        const render = await page.evaluate(() => {
          const rows = (window as any).__sunoCaptchaChallenge?.renders || [];
          return rows.length ? rows[rows.length - 1] : null;
        }).catch(() => null);
        captured = mergeCaptchaChallenges(
          captured,
          captchaChallengeFromRender(
            render,
            page.url(),
            actualUserAgent || this.userAgent || '',
          ),
        );
        if (captured?.rqdata || (captured && Date.now() - started >= 5_000)) break;
        await abortableCaptchaDelay(250, signal);
      }
      if (signal.aborted) throw signal.reason || new Error('captcha_cancelled');
      const context = captured || staticCaptchaChallenge(
        defaultSitekey,
        page.url() || 'https://suno.com/create',
        actualUserAgent || this.userAgent || '',
      );
      logger.info(captchaChallengeSummary(context), 'Captured Suno hCaptcha challenge context');
      return context;
    } finally {
      signal.removeEventListener('abort', abortBrowser);
      await browser.close().catch(() => undefined);
    }
  }

  private async getCaptchaProof(
    signal: AbortSignal,
    session: CaptchaCoordinatorSession,
    captchaRequiredKnown = false,
  ): Promise<CaptchaProof | null> {
    if (signal.aborted) throw signal.reason || new Error('captcha_cancelled');
    if (!captchaRequiredKnown && !await this.captchaRequired()) return null;
    await loadCaptchaSettings(true);
    const defaultSitekey = (
      process.env.SUNO_HCAPTCHA_SITEKEY
      || 'd65453de-3f1a-4aac-9366-a0f06e52b2ce'
    ).trim();
    const forceLive = process.env.CAPTCHA_FORCE_LIVE_CHALLENGE === '1';
    const useVerifiedStatic = this.lastCaptchaVersion === 1 && !forceLive;
    // Force-live means exactly one fresh browser capture for this acquisition.
    // Otherwise cache only within the same Suno account, with a fixed expiry
    // set at capture time. A cache read must never renew the challenge.
    const cached = forceLive || useVerifiedStatic
      ? null
      : captchaChallengeCache.get(this.accountKey);
    const cacheHit = Boolean(cached);
    const context = useVerifiedStatic
      ? verifiedStaticCaptchaChallenge(
          defaultSitekey,
          'https://suno.com/create',
          this.userAgent || SUNO_CAPTCHA_BROWSER_USER_AGENT,
        )
      : cached
        ? cached.context
        : await this.captureCaptchaChallenge(signal);
    logger.info({
      ...captchaChallengeSummary(context),
      cacheHit,
      cacheAgeMs: cached?.ageMs ?? 0,
      forceLive,
    }, 'Resolved Suno hCaptcha challenge context');
    if (
      !forceLive
      && !cacheHit
      && context.source !== 'static_fallback'
      && !context.rqdata
      && !context.enterprisePayload
    ) {
      captchaChallengeCache.set(this.accountKey, context);
    }
    try {
      return await session.solve(context);
    } catch (error) {
      // A provider timeout/unsolvable response is evidence that the captured
      // context is no longer useful. Never fan it out to later requests.
      captchaChallengeCache.delete(this.accountKey);
      throw error;
    }
  }

  /** Keep acquisition and the matching Suno POST inside one account/global gate. */
  private async submitGenerationRequest(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<any> {
    const coordinator = getCaptchaCoordinator();
    if (coordinator.isAccountBlocked(this.accountKey)) {
      throw new SunoPublicError(
        'suno_captcha_unavailable',
        'This Suno account is already solving a CAPTCHA. Retry after the current challenge finishes.',
        503,
        {
          submissionState: 'not_submitted',
          retryable: true,
          retryAfterSeconds: coordinator.retryAfterSeconds(this.accountKey),
          recordAccountFailure: false,
          allowAccountFailover: true,
        },
      );
    }
    if (!await this.captchaRequired()) {
      return this.client.post(endpoint, { ...payload, token: null }, { timeout: timeoutMs });
    }
    let postStarted = false;
    try {
      return await runWithCaptchaAcquisitionDeadline(
        (signal) => coordinator.run(this.accountKey, signal, async (session) => {
          const proof = await this.getCaptchaProof(signal, session, true);
          const requestPayload = { ...payload, token: proof?.token || null };
          postStarted = true;
          try {
            const response = await this.client.post(endpoint, requestPayload, {
              timeout: timeoutMs,
              signal,
              headers: proof?.userAgent
                ? { 'User-Agent': proof.userAgent }
                : undefined,
            });
            if (proof) {
              if (generationResponseWasAccepted(response)) await session.report(proof, 'good');
              else session.recordIndeterminate(proof);
            }
            return response;
          } catch (error: any) {
            if (proof && captchaWasExplicitlyRejected(error)) {
              captchaChallengeCache.delete(this.accountKey);
              await session.report(proof, 'bad');
              throw new SunoPublicError(
                'suno_captcha_unavailable',
                'Suno rejected the CAPTCHA proof before accepting the generation request.',
                503,
                {
                  submissionState: 'not_submitted',
                  retryable: true,
                  retryAfterSeconds: coordinator.retryAfterSeconds(this.accountKey),
                  recordAccountFailure: false,
                },
              );
            }
            if (proof && postOutcomeIsIndeterminate(error)) session.recordIndeterminate(proof);
            throw error;
          }
        }),
        captchaAcquisitionTimeoutMs(),
      );
    } catch (error: any) {
      if (error instanceof SunoPublicError || postStarted) throw error;
      const diagnosticCodes = error instanceof CaptchaProvidersUnavailableError
        ? error.providerCodes
        : Array.isArray(error?.providerCodes)
          ? error.providerCodes
          : [];
      logger.warn(
        {
          code: typeof error?.code === 'string' ? error.code : 'captcha_acquisition_failed',
          errorType: error?.constructor?.name || 'Error',
          diagnosticCodes,
        },
        'CAPTCHA acquisition failed before Suno submission',
      );
      throw new SunoPublicError(
        'suno_captcha_unavailable',
        'Suno CAPTCHA could not be completed. Check provider diagnostics and retry.',
        503,
        {
          submissionState: 'not_submitted',
          retryable: true,
          retryAfterSeconds: coordinator.retryAfterSeconds(this.accountKey),
          recordAccountFailure: false,
          diagnosticCodes,
        },
      );
    }
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(signal?: AbortSignal): Promise<string|null> {
    const controller = signal ? null : new AbortController();
    const resolvedSignal = signal || controller!.signal;
    const coordinator = getCaptchaCoordinator();
    if (coordinator.isAccountBlocked(this.accountKey)) {
      throw new SunoPublicError(
        'suno_captcha_unavailable',
        'This Suno account is already solving a CAPTCHA.',
        503,
        {
          submissionState: 'not_submitted',
          retryable: true,
          retryAfterSeconds: coordinator.retryAfterSeconds(this.accountKey),
          recordAccountFailure: false,
          allowAccountFailover: true,
        },
      );
    }
    return coordinator.run(this.accountKey, resolvedSignal, async (session) => (
      (await this.getCaptchaProof(resolvedSignal, session))?.token || null
    ));
  }

  private async dismissOverlays(page: Page): Promise<void> {
    const candidates = [
      page.getByRole('button', { name: /accept all cookies/i }),
      page.getByRole('button', { name: /reject all/i }),
      page.locator('#onetrust-accept-btn-handler'),
      page.locator('.onetrust-close-btn-handler'),
      page.getByLabel('Close'),
      page.locator('button[aria-label="Close"]'),
    ];
    for (const loc of candidates) {
      try {
        const btn = loc.first();
        if (await btn.isVisible({ timeout: 800 })) {
          await btn.click({ timeout: 1500 });
          await sleep(0.5);
        }
      } catch {}
    }
    try {
      await page.keyboard.press('Escape');
    } catch {}
  }

  private async findPromptInput(page: Page): Promise<Locator> {
    await this.dismissOverlays(page);

    // Prefer the Simple mode song description box on modern Suno UI.
    // Note: Playwright may report it as hidden even when it has a box (overlays / CSS).
    const preferred = [
      // Current Simple mode uses maxlength=3000. "Describe the sound you
      // want" belongs to a hidden Advanced panel and must not win merely
      // because it is attached to the DOM.
      page.locator('textarea[maxlength="3000"]'),
      page.locator('textarea[placeholder*="song description" i]'),
      page.locator('.custom-textarea'),
      page.locator('textarea[placeholder*="Describe the sound" i]'),
      page.getByPlaceholder(/describe the sound you want/i),
    ];
    for (const loc of preferred) {
      try {
        const target = loc.first();
        await target.waitFor({ state: 'visible', timeout: 12_000 });
        if (await target.isVisible().catch(() => false)) return target;
      } catch {}
    }

    // Fall back to any non-lyrics textarea/textbox that is not the lyrics editor.
    const all = page.locator('textarea, [contenteditable="true"], [role="textbox"]');
    const count = await all.count();
    for (let i = 0; i < count; i++) {
      const item = all.nth(i);
      const aria = ((await item.getAttribute('aria-label')) || '').toLowerCase();
      const placeholder = ((await item.getAttribute('placeholder')) || '').toLowerCase();
      if (aria.includes('lyrics') || aria.includes('cowriter')) continue;
      if (placeholder.includes('manele') || placeholder.includes('gentle')) continue; // style tags box
      try {
        await item.waitFor({ state: 'attached', timeout: 1000 });
        return item;
      } catch {}
    }
    throw new Error('Could not find Suno song description input');
  }

  private async forceFillPrompt(page: Page, locator: Locator, text: string): Promise<void> {
    if (await locator.isVisible().catch(() => false)) {
      try {
        await locator.fill(text, { force: true, timeout: 5_000 });
        if ((await locator.inputValue().catch(() => '')).trim()) return;
      } catch {}
    }
    await locator.evaluate((el: HTMLElement) => {
      let node: HTMLElement | null = el;
      while (node) {
        node.style.setProperty('opacity', '1', 'important');
        node.style.setProperty('visibility', 'visible', 'important');
        node.style.setProperty('pointer-events', 'auto', 'important');
        node = node.parentElement;
      }
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    try {
      await page.locator('text=Song Description').first().click({ force: true, timeout: 2000 });
    } catch {}
    try {
      await locator.click({ force: true, timeout: 5000 });
    } catch {
      await locator.evaluate((el: HTMLElement) => el.focus());
    }

    // Paste is the most reliable way to update Suno\'s React prompt state.
    try {
      await page.evaluate(async (value) => {
        await navigator.clipboard.writeText(value);
      }, text);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+V');
    } catch {
      try {
        const client = await page.context().newCDPSession(page);
        await client.send('Input.insertText', { text });
      } catch {
        await page.keyboard.type(text, { delay: 20 });
      }
    }

    // Fallback tracker assignment if counter still empty.
    const counterOk = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return !/\n0\/3000\b/.test(body) && !/Song Description\s*0\/3000/i.test(body);
    });
    if (!counterOk) {
      await locator.evaluate((el: any, value: string) => {
        const proto = window.HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const last = el.value;
        if (desc?.set) desc.set.call(el, value); else el.value = value;
        if (el._valueTracker) el._valueTracker.setValue(last ?? '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertFromPaste' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, text);
    }
    await sleep(0.5);
  }

  private async findCreateButton(page: Page): Promise<Locator> {
    await this.dismissOverlays(page);
    const candidates = [
      page.locator('button[aria-label="Create song"]'),
      page.locator('button[aria-label="Create"]'),
      page.getByRole('button', { name: /create song/i }),
      page.getByRole('button', { name: /^create$/i }),
      page.locator('button').filter({ hasText: /^create$/i }),
      page.getByRole('button', { name: /create|generate|make song/i }),
      page.locator('button').filter({ hasText: /create|generate/i }),
    ];
    for (const loc of candidates) {
      try {
        const target = loc.first();
        await target.waitFor({ state: 'attached', timeout: 3000 });
        if (await target.isVisible().catch(() => false)
          && !await target.isDisabled().catch(() => true)) return target;
        const box = await target.boundingBox();
        if (box && box.width > 0 && box.height > 0) return target;
      } catch {}
    }
    throw new Error('Could not find Suno Create/Generate button');
  }

  private async waitForHCaptchaSitekey(page: Page, timeoutMs = 20000): Promise<string | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const sitekey = await page.evaluate(() => {
        const attr = document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey');
        if (attr) return attr;
        const iframe = Array.from(document.querySelectorAll('iframe')).find((el) => {
          const src = el.getAttribute('src') || '';
          return src.includes('hcaptcha.com') || (el.getAttribute('title') || '').includes('hCaptcha');
        });
        if (!iframe) return null;
        const src = iframe.getAttribute('src') || '';
        try {
          const url = new URL(src, location.origin);
          return url.searchParams.get('sitekey');
        } catch {
          const m = src.match(/[?&]sitekey=([^&]+)/);
          return m ? decodeURIComponent(m[1]) : null;
        }
      });
      if (sitekey) return sitekey;
      await sleep(1);
    }
    return null;
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    voice?: VoiceSelection,
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio,
      undefined,
      undefined,
      undefined,
      undefined,
      voice,
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    voice?: VoiceSelection,
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
      undefined,
      undefined,
      undefined,
      voice,
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number,
    voice?: VoiceSelection,
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    const resolvedVoice = await this.resolveVoiceSelection(voice);
    const payload: any = {
      make_instrumental: make_instrumental,
      mv: resolveSunoProviderModel(model),
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: task,
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    if (resolvedVoice) applyVoiceToPayload(payload, resolvedVoice, { cover: false });
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            payload: {
              ...payload,
              token: payload.token ? '[redacted]' : undefined,
            }
          },
          null,
          2
        )
    );
    const response = await this.submitGenerationRequest(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      10_000,
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }

  /** Submit Suno's current Advanced split extraction for the requested tracks. */
  public async generateAdvancedStems(
    sourceClipId: string,
    projectId: string,
    stemName: unknown,
  ): Promise<AdvancedStemGeneration> {
    const sourceId = String(sourceClipId || '').trim();
    if (!sourceId) throw new SunoPublicError('invalid_clip_id', 'Source clip id is required.', 400);
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) {
      throw new SunoPublicError('invalid_project_id', 'Studio project id is required.', 400);
    }
    const requestedStems = normalizeAdvancedStemNames([stemName]);
    if (requestedStems.length !== 1) {
      throw new SunoPublicError(
        'invalid_stem_selection',
        'Exactly one Advanced Split stem is required per submission.',
        400,
      );
    }
    await this.keepAlive(false);
    const submissions: AdvancedStemGeneration['submissions'] = [];
    const requestedStem = requestedStems[0];
    const transactionUuid = randomUUID();
    const payload = {
      task: 'gen_stem',
      mv: 'chirp-v3-5-b',
      project_id: normalizedProjectId,
      stem_type_id: 91,
      stem_type_group_name: requestedStem,
      stem_task: 'extract',
      stem_name: requestedStem,
      continue_clip_id: sourceId,
      generation_type: 'TEXT',
      make_instrumental: true,
      prompt: '',
      tags: '',
      negative_tags: '',
      transaction_uuid: transactionUuid,
      token_provider: null,
      metadata: {
        web_client_pathname: `/studio/${normalizedProjectId}`,
        create_surface: 'studio',
        create_mode: 'custom',
        from_studio_project_id: normalizedProjectId,
        is_remix: true,
      },
    };
    const response = await this.submitGenerationRequest(
      `${SunoApi.BASE_URL}/api/generate/v2-web/`,
      payload,
      30_000,
    );
    const clips = advancedStemClips(response.data)
      .map((clip, index) => classifyAdvancedStemClip(clip, requestedStem, index));
    if (!clips.length) {
      // A successful HTTP response without clip ids cannot prove whether
      // Suno accepted the extraction. The Runtime will reconcile instead
      // of blindly submitting this track again.
      throw new Error(`Suno returned no clip ids for the ${requestedStem} extraction.`);
    }
    submissions.push({ stem_name: requestedStem, transaction_uuid: transactionUuid, clips });
    return {
      source_clip_id: sourceId,
      project_id: normalizedProjectId,
      requested_stems: requestedStems,
      submissions,
      clips: submissions.flatMap((item) => item.clips),
    };
  }

  /** List every Advanced split version associated with one source clip. */
  public async listAdvancedStems(sourceClipId: string): Promise<AdvancedStemListing> {
    const sourceId = String(sourceClipId || '').trim();
    if (!sourceId) throw new SunoPublicError('invalid_clip_id', 'Source clip id is required.', 400);
    await this.keepAlive(false);
    const pagesResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${encodeURIComponent(sourceId)}/stems/pages`,
      { timeout: 30000 },
    );
    const advertisedPages = providerPageCount(pagesResponse.data);
    const clips: AdvancedStemClip[] = [];
    const pageLimit = advertisedPages === null ? 1 : Math.min(advertisedPages, 100);
    for (let page = 0; page < pageLimit; page += 1) {
      const response = await this.client.get(
        `${SunoApi.BASE_URL}/api/clip/${encodeURIComponent(sourceId)}/stems?page=${page}`,
        { timeout: 30000 },
      );
       clips.push(...advancedStemClips(response.data));
    }
    const deduplicated = [...new Map(
      clips.map((clip) => [String(clip.id), clip] as const),
    ).values()];
    return {
      source_clip_id: sourceId,
      pages: advertisedPages ?? (deduplicated.length ? 1 : 0),
       clips: deduplicated.map((clip, index) => classifyAdvancedStemClip(clip, undefined, index)),
    };
  }

  /** Poll Suno's downbeat analysis used by fixed-tempo Studio rendering. */
  public async getDownbeats(clipId: string, maxPollAttempts = 90) {
    const normalizedId = String(clipId || '').trim();
    if (!normalizedId) throw new SunoPublicError('invalid_clip_id', 'Clip id is required.', 400);
    await this.keepAlive(false);
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const response = await this.client.get(
        `${SunoApi.BASE_URL}/api/gen/${encodeURIComponent(normalizedId)}/downbeats`,
        { timeout: 30000 },
      );
      const downbeats = normalizeDownbeats(response.data);
      if (downbeats.length >= 2) return downbeats;
      const state = providerState(response.data);
      if (['error', 'failed', 'failure', 'rejected'].includes(state)) {
        throw new SunoPublicError(
          'stem_render_tempo_failed',
          'Suno could not analyze the source tempo.',
          502,
        );
      }
      if (state === 'complete' || state === 'completed') {
        throw new SunoPublicError(
          'stem_render_tempo_failed',
          'Suno completed tempo analysis without usable downbeats.',
          502,
        );
      }
      await sleep(2, 2);
      if (attempt > 0 && attempt % 10 === 0) await this.keepAlive(false);
    }
    throw new SunoPublicError(
      'stem_render_tempo_failed',
      'Suno tempo analysis timed out.',
      504,
    );
  }

  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  private mapAudioInfo(audio: any): AudioInfo {
    const metadata = audio?.metadata || {};
    return {
      id: String(audio?.id || ''),
      title: audio?.title,
      image_url: audio?.image_url,
      lyric: metadata.prompt ? this.parseLyrics(String(metadata.prompt)) : '',
      audio_url: audio?.audio_url,
      video_url: audio?.video_url,
      created_at: String(audio?.created_at || ''),
      model_name: String(audio?.model_name || metadata?.model_name || ''),
      status: String(audio?.status || ''),
      gpt_description_prompt: metadata.gpt_description_prompt,
      prompt: metadata.prompt,
      type: metadata.type,
      tags: metadata.tags,
      negative_tags: metadata.negative_tags,
      duration: metadata.duration,
      error_message: metadata.error_message,
    };
  }

  private async waitForAudio(songIds: string[]): Promise<AudioInfo[]> {
    const startTime = Date.now();
    let lastResponse: AudioInfo[] = [];
    await sleep(5, 5);
    while (Date.now() - startTime < 100000) {
      const response = await this.get(songIds);
      const allCompleted = response.every((audio) => audio.status === 'streaming' || audio.status === 'complete');
      const allError = response.every((audio) => audio.status === 'error');
      if (allCompleted || allError) return response;
      lastResponse = response;
      await sleep(3, 6);
      await this.keepAlive(true);
    }
    return lastResponse;
  }

  private getAudioExtension(filename: string, fallback?: string): string {
    const candidate = (fallback || path.extname(filename).replace('.', '') || '').trim().toLowerCase();
    return candidate || 'mp3';
  }

  private guessAudioMime(filename: string): string {
    const ext = this.getAudioExtension(filename);
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'm4a') return 'audio/mp4';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'flac') return 'audio/flac';
    if (ext === 'ogg') return 'audio/ogg';
    return 'audio/mpeg';
  }

  /** Upload a local audio file and wait until Suno finishes processing it. */
  public async uploadAudio(
    file: Buffer | Uint8Array | ArrayBuffer,
    filename: string,
    options: UploadAudioOptions = {},
  ): Promise<UploadedAudioInfo> {
    await this.keepAlive(false);
    const fileBuffer = Buffer.isBuffer(file)
      ? file
      : file instanceof ArrayBuffer
        ? Buffer.from(file)
        : Buffer.from(file);
    const extension = this.getAudioExtension(filename, options.extension);
    const uploadType = options.upload_type || 'file_upload';

    const createResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/uploads/audio/`,
      { extension, is_stem_mix: false, upload_type: uploadType },
      { timeout: 30000 },
    );
    const upload = createResponse.data;
    if (!upload?.id || !upload?.url || !upload?.fields) {
      throw new Error('Suno did not return a valid audio upload target.');
    }

    const formData = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) {
      formData.append(key, String(value));
    }
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: this.guessAudioMime(filename) });
    formData.append('file', blob, filename);
    await axios.post(upload.url, formData, {
      proxy: this.proxy?.axios,
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    await this.client.post(
      `${SunoApi.BASE_URL}/api/uploads/audio/${upload.id}/upload-finish/`,
      { upload_type: uploadType, upload_filename: filename },
      { timeout: 30000 },
    );

    const maxAttempts = options.max_poll_attempts || 75;
    const intervalSeconds = options.poll_interval_seconds || 4;
    let lastStatus: UploadedAudioInfo = { id: upload.id, status: 'pending' };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(intervalSeconds, intervalSeconds);
      await this.keepAlive(false);
      const statusResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/uploads/audio/${upload.id}/`,
        { timeout: 30000 },
      );
      lastStatus = { id: upload.id, ...statusResponse.data };
      const status = String(lastStatus.status || '').toLowerCase();
      if (status === 'complete' || status === 'completed') return lastStatus;
      if (['error', 'failed', 'failure', 'rejected'].includes(status)) {
        const reason = String(lastStatus.error_message || lastStatus.error_type || '').trim();
        const duplicate = /matches an existing recording/i.test(reason);
        throw new SunoPublicError(
          duplicate ? 'audio_catalog_duplicate' : 'audio_upload_rejected',
          duplicate
            ? 'Audio upload was rejected because it matches an existing recording.'
            : 'Suno rejected the uploaded audio.',
          duplicate ? 409 : 422,
        );
      }
    }
    throw new Error(`Audio upload timed out before processing completed. Last status: ${lastStatus.status || 'unknown'}`);
  }

  public async setUploadedClipMetadata(
    clipId: string,
    metadata: InitializeUploadedClipMetadata = {},
  ): Promise<any> {
    await this.keepAlive(false);
    const payload: any = { is_audio_upload_tos_accepted: true };
    if (metadata.title !== undefined) payload.title = metadata.title;
    if (metadata.image_url !== undefined) payload.image_url = metadata.image_url;
    if (metadata.lyrics !== undefined || metadata.prompt !== undefined) {
      payload.lyrics = metadata.lyrics ?? metadata.prompt ?? '';
    }
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/gen/${clipId}/set_metadata/`,
      payload,
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'clip_metadata');
  }

  /**
   * Update the user-visible style/audio description for an uploaded clip.
   *
   * Suno does not accept this value in ``set_metadata``.  The web client sends
   * it to ``set_audio_description`` under the deliberately named
   * ``user_corrected_description`` field instead.
   */
  public async setUploadedClipAudioDescription(
    clipId: string,
    description: string,
  ): Promise<any> {
    const normalizedClipId = String(clipId || '').trim();
    if (!normalizedClipId) throw new Error('clipId is required.');
    await this.keepAlive(false);
    const payload: UploadedClipAudioDescription = {
      user_corrected_description: String(description ?? ''),
    };
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/gen/${normalizedClipId}/set_audio_description`,
      payload,
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'audio_description');
  }

  /**
   * Update the style summary used by rendered Studio/context-window clips.
   * ``user_corrected_description`` is only accepted for raw ``upload``
   * clips; the Song Details editor uses ``display_tags`` for the rendered
   * clip returned by Studio fast upload.
   */
  public async setUploadedClipDisplayTags(
    clipId: string,
    displayTags: string,
  ): Promise<any> {
    const normalizedClipId = String(clipId || '').trim();
    if (!normalizedClipId) throw new Error('clipId is required.');
    await this.keepAlive(false);
    const payload: UploadedClipDisplayTags = {
      display_tags: String(displayTags ?? ''),
    };
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/gen/${normalizedClipId}/set_display_tags`,
      payload,
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'display_tags');
  }

  /** Initialize a processed upload as a normal Suno clip. */
  public async initializeUploadedClip(
    uploadId: string,
    metadata: InitializeUploadedClipMetadata = {},
  ): Promise<InitializedUploadedClipInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/initialize-clip/`,
      metadata.user_reviewed_tags === false ? {} : { user_reviewed_tags: true },
      { timeout: 30000 },
    );
    const clipId = response.data?.clip_id || response.data?.id;
    if (!clipId) throw new Error('Suno did not return a clip_id for the uploaded audio.');
    if (metadata.title || metadata.prompt || metadata.lyrics || metadata.image_url) {
      await this.setUploadedClipMetadata(clipId, metadata);
    }
    const uploadResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/`,
      { timeout: 30000 },
    );
    return {
      id: uploadId,
      ...uploadResponse.data,
      upload_id: uploadId,
      clip_id: String(clipId),
    };
  }

  /** Create a cover while keeping the source clip on its owning account. */
  public async cover(
    clipId: string,
    tags: string,
    title: string,
    prompt?: string,
    model?: string,
    personaId?: string,
    personaModel?: string,
    waitAudio = false,
    negativeTags?: string,
    voice?: VoiceSelection,
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const resolvedVoice = await this.resolveVoiceSelection(voice);
    const payload: any = {
      task: 'cover',
      generation_type: 'TEXT',
      title: title || '',
      tags: tags || '',
      negative_tags: negativeTags || '',
      mv: resolveSunoProviderModel(model),
      prompt: prompt || '',
      make_instrumental: false,
      user_uploaded_images_b64: null,
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        is_mumble: false,
        create_mode: 'custom',
        disable_volume_normalization: false,
        is_remix: true,
      },
      override_fields: [],
      cover_clip_id: clipId,
      persona_id: personaId || null,
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      continue_clip_id: null,
      continued_aligned_prompt: null,
      continue_at: null,
      transaction_uuid: randomUUID(),
      token_provider: null,
    };
    if (personaId) payload.persona_model = personaModel || 'style_persona';
    if (resolvedVoice) applyVoiceToPayload(payload, resolvedVoice, { cover: true });
    const response = await this.submitGenerationRequest(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      30_000,
    );
    const clips = Array.isArray(response.data?.clips) ? response.data.clips : [];
    const songIds = clips.map((audio: any) => String(audio?.id || '')).filter(Boolean);
    if (!songIds.length) throw new Error('Suno returned no clip ids for the cover request.');
    if (waitAudio) return this.waitForAudio(songIds);
    return clips.map((audio: any) => this.mapAudioInfo(audio));
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Read a Studio project using the account that created it.
   *
   * This deliberately returns the provider payload unchanged to the
   * fast-upload reconciler only; no public route exposes it.  Keeping this
   * method on the account-bound API instance is important because Studio
   * projects are private to the owning Suno account.
   */
  public async getStudioProject(projectId: string): Promise<any> {
    const normalized = String(projectId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      throw new SunoPublicError('invalid_project_id', 'Project id is required.', 400);
    }
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/studio/project/${encodeURIComponent(normalized)}`,
      { timeout: 15000 },
    );
    return response.data;
  }

  /** List Studio projects that reference a Clip on this Suno account. */
  public async listStudioProjectsForClip(clipId: string): Promise<any> {
    const normalized = String(clipId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      throw new SunoPublicError('invalid_clip_id', 'Clip id is required.', 400);
    }
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/studio/clips/${encodeURIComponent(normalized)}/projects`,
      { timeout: 15000 },
    );
    return response.data;
  }

  /** Create or load the Studio project associated with a source Clip. */
  public async createOrLoadStudioProjectForClip(clipId: string): Promise<any> {
    const normalized = String(clipId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      throw new SunoPublicError('invalid_clip_id', 'Clip id is required.', 400);
    }
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/studio/create-or-load-project-for-clip/${encodeURIComponent(normalized)}`,
      undefined,
      { timeout: 30000 },
    );
    const value = assertProviderMutationSuccess(response.data, 'studio_project_create');
    const projectId = value && typeof value === 'object'
      ? String(value.id || value.project_id || value.project?.id || '').trim()
      : '';
    if (!projectId) {
      throw new SunoPublicError(
        'studio_project_invalid_response',
        'Suno did not return a Studio project id.',
        502,
        { retryable: false },
      );
    }
    return value.id ? value : { ...value, id: projectId };
  }

  /** Read the raw Feed response without dropping provider/project metadata. */
  public async getRawFeed(songIds?: string[], page?: string | null): Promise<any> {
    await this.keepAlive(false);
    const url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    const ids = (songIds || [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (ids.length) url.searchParams.set('ids', ids.join(','));
    if (page) url.searchParams.set('page', String(page));
    const response = await this.client.get(url.href, { timeout: 15000 });
    return response.data;
  }

  /** Trash only explicitly identified clips (used by safe upload cleanup). */
  public async trashClips(clipIds: string[]): Promise<any> {
    const ids = Array.from(new Set(
      (clipIds || []).map((value) => String(value || '').trim()).filter(Boolean),
    ));
    if (!ids.length) return { clips: [] };
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/gen/trash`,
      { trash: true, clip_ids: ids },
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'clip_trash');
  }

  /** Persist a previously read Studio project state after safe clip removal. */
  public async saveStudioProject(
    projectId: string,
    state: any,
    title?: string,
  ): Promise<any> {
    const normalized = String(projectId || '').trim();
    if (!normalized) throw new Error('projectId is required.');
    await this.keepAlive(false);
    const payload: Record<string, any> = {
      project_id: normalized,
      state,
    };
    if (title !== undefined) payload.title = String(title);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/studio/save-project`,
      payload,
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'studio_project_save');
  }

  /** Prepare a WAV (or another Studio-supported) single-clip export. */
  public async getStudioClipDownloadStatus(
    clipId: string,
    format: 'wav' | 'mp3' | 'm4a' = 'wav',
  ): Promise<StudioClipDownloadStatus> {
    const normalized = String(clipId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      throw new SunoPublicError('invalid_clip_id', 'Clip id is required.', 400);
    }
    const normalizedFormat = format === 'mp3' || format === 'm4a' ? format : 'wav';
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/studio/clip/${encodeURIComponent(normalized)}/download`,
      {
        params: { format: normalizedFormat },
        timeout: 30_000,
      },
    );
    return normalizeStudioClipDownloadResponse(
      normalized,
      normalizedFormat,
      response.data,
    );
  }

  /**
   * Archive exactly one Studio v2 project.
   *
   * Studio projects are not Workspace projects: the latter use
   * ``/api/project/trash`` while Studio v2 exposes the operation as
   * ``/api/studio/project/{project_id}/archive``.  Calling the Workspace
   * endpoint for a Studio id consistently returns ``Project not found``.
   */
  public async archiveStudioProject(projectId: string): Promise<any> {
    const normalized = String(projectId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      throw new SunoPublicError('invalid_project_id', 'Studio project id is required.', 400);
    }
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/studio/project/${encodeURIComponent(normalized)}/archive`,
      undefined,
      { timeout: 30000 },
    );
    return assertProviderMutationSuccess(response.data, 'studio_project_archive');
  }

  /** Backwards-compatible name used by the runtime cleanup journal. */
  public async trashStudioProject(projectId: string): Promise<any> {
    return this.archiveStudioProject(projectId);
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);

    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;

    logger.info(`Fetching persona data: ${url}`);

    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }

  /**
   * Ask Suno to prepare a stable downloadable rendition for a completed Clip.
   *
   * Feed `status=complete` means generation has finished, but it does not mean
   * the CDN MP3 is ready.  Suno's web client treats `/api/download/clip/...`
   * as a second, independently-polled state machine.  Keep that distinction
   * in API Plus so Runtime never burns its download retry budget on a normal
   * `processing` response.
   */
  public async getClipDownloadStatus(
    clipId: string,
    format: 'mp3' | 'm4a' = 'mp3',
  ): Promise<ClipDownloadStatus> {
    const normalizedId = String(clipId || '').trim();
    if (!normalizedId) {
      throw new SunoPublicError('invalid_clip_id', 'Clip id is required.', 400);
    }
    const normalizedFormat = format === 'm4a' ? 'm4a' : 'mp3';
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/download/clip/${encodeURIComponent(normalizedId)}`,
      {
        params: { format: normalizedFormat },
        timeout: 30_000,
      },
    );
    return normalizeClipDownloadResponse(
      normalizedId,
      normalizedFormat,
      response.data,
    );
  }

  /** Resolve one public Voice so callers only need its public id or URL. */
  public async getVoice(voiceId: string): Promise<SunoVoice> {
    await this.keepAlive(false);
    const normalizedId = normalizeVoiceId(voiceId);
    if (!normalizedId) throw new VoiceRequestError('voice_id is required.');
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/persona/get-persona/${encodeURIComponent(normalizedId)}/`,
      { timeout: 10000 },
    );
    return normalizeVoice(response.data?.persona || response.data || {});
  }

  private async resolveVoiceSelection(voice?: VoiceSelection): Promise<VoiceSelection | undefined> {
    if (!voice) return undefined;
    const id = String(voice.id || '').trim();
    if (!id) throw new VoiceRequestError('voice_id is required.');
    const resolved = await this.getVoice(id);
    assertPublicVoice(resolved);
    return { id, ...(resolved.voice_clip_id ? { clipId: resolved.voice_clip_id } : {}) };
  }
}

async function directSunoApi(resolvedCookie: string, accountKey?: string) {
  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance.bindAccountKey(accountKey);

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie, accountKey).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
}

let pooledProxy: SunoApi | undefined;
let quotaSchedulerStarted = false;

function startQuotaScheduler() {
  if (quotaSchedulerStarted) return;
  quotaSchedulerStarted = true;
  const pool = getAccountPool();
  const refresh = () => pool.refreshStale(async (accountCookie) => (
    await directSunoApi(accountCookie)
  ).get_credits()).catch((error) => logger.warn({ error }, 'Account quota sync failed'));
  void refresh();
  const intervalMs = Math.max(60, Number(process.env.ACCOUNT_QUOTA_SYNC_INTERVAL_SEC) || 300) * 1000;
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
}

export async function withSunoAccount<T>(
  tier: AccountTier,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
  maxAttempts = 3,
) {
  startQuotaScheduler();
  return getAccountPool().execute(tier, async (accountCookie, account) => (
    operation(await directSunoApi(accountCookie, account?.id), account)
  ), maxAttempts);
}

export async function withSunoAccountExclusive<T>(
  tier: AccountTier,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
) {
  startQuotaScheduler();
  return getAccountPool().executeExclusive(tier, async (accountCookie, account) => (
    operation(await directSunoApi(accountCookie, account?.id), account)
  ));
}

export async function withSunoAccountAffinity<T>(
  tier: AccountTier,
  accountId: string,
  operation: (api: SunoApi, account: AccountView) => Promise<T>,
) {
  startQuotaScheduler();
  return getAccountPool().executeForAccount(tier, accountId, async (accountCookie, account) => (
    operation(await directSunoApi(accountCookie, account.id), account)
  ));
}

export async function withSunoAccountAffinityLong<T>(
  tier: AccountTier,
  accountId: string,
  operation: (api: SunoApi, account: AccountView) => Promise<T>,
  options: AffinityWaitOptions = {},
) {
  startQuotaScheduler();
  return getAccountPool().executeLongForAccount(
    tier,
    accountId,
    async (accountCookie, account) => operation(await directSunoApi(accountCookie, account.id), account),
    options,
  );
}

export async function runSunoRequest<T>(
  requestCookie: string | undefined,
  tier: AccountTier,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
  maxAttempts = 3,
) {
  if (requestCookie?.includes('__client')) {
    return operation(await directSunoApi(requestCookie), null);
  }
  return withSunoAccount(tier, operation, maxAttempts);
}

export async function runSunoRequestExclusive<T>(
  requestCookie: string | undefined,
  tier: AccountTier,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
) {
  if (requestCookie?.includes('__client')) {
    return operation(await directSunoApi(requestCookie), null);
  }
  return withSunoAccountExclusive(tier, operation);
}

export async function runSunoRequestWithAffinity<T>(
  requestCookie: string | undefined,
  tier: AccountTier,
  accountId: string | undefined,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
  maxAttempts = 3,
) {
  if (requestCookie?.includes('__client')) {
    return operation(await directSunoApi(requestCookie), null);
  }
  if (accountId) return withSunoAccountAffinity(tier, accountId, operation);
  return withSunoAccount(tier, operation, maxAttempts);
}

/** Long-running Advanced stems post-processing with a per-account FIFO gate. */
export async function runSunoLongRequestWithAffinity<T>(
  requestCookie: string | undefined,
  tier: AccountTier,
  accountId: string | undefined,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
  options: AffinityWaitOptions = {},
) {
  startQuotaScheduler();
  if (requestCookie?.includes('__client')) {
    return getAccountPool().executeLong(
      `cookie:${Buffer.from(requestCookie).toString('base64url').slice(0, 32)}`,
      async () => operation(await directSunoApi(requestCookie), null),
      options,
    );
  }
  if (accountId) {
    return withSunoAccountAffinityLong<T>(
      tier,
      accountId,
      (api, account) => operation(api, account),
      options,
    );
  }
  // Without a source affinity token there is no safe account-specific key;
  // serialize the fallback pool operation so two long requests cannot occupy
  // the same selected account concurrently.
  return getAccountPool().executeLong(
    `tier:${tier}`,
    () => withSunoAccount(tier, operation, 1),
    options,
  );
}

function getPooledProxy() {
  if (pooledProxy) return pooledProxy;
  pooledProxy = new Proxy({} as SunoApi, {
    get(_target, property) {
      // Prevent async functions from treating the proxy itself as a Promise.
      if (property === 'then') return undefined;
      if (typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => withSunoAccount('basic', async (api) => {
        const method = (api as any)[property];
        if (typeof method !== 'function') throw new Error(`Unknown Suno API method: ${property}`);
        return method.apply(api, args);
      });
    },
  });
  return pooledProxy;
}

export const sunoApi = async (requestCookie?: string) => {
  const explicitCookie = requestCookie && requestCookie.includes('__client') ? requestCookie : undefined;
  if (explicitCookie) return directSunoApi(explicitCookie);

  startQuotaScheduler();
  if (await getAccountPool().hasStoredAccounts()) return getPooledProxy();

  if (process.env.SUNO_COOKIE) return directSunoApi(process.env.SUNO_COOKIE);
  logger.info('No cookie provided! Aborting...\nPlease configure an account in the admin console or set SUNO_COOKIE.');
  throw new Error('Please configure a Suno account in the admin console or set SUNO_COOKIE.');
};
