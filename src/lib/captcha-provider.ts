import axios, { AxiosProxyConfig } from 'axios';
import type { CaptchaChallengeContextV1 } from '@/lib/captcha-challenge';
import { getCaptchaSettingsSync } from '@/lib/captcha-settings';

export type CaptchaProviderName = 'yescaptcha' | '2captcha';
export type CaptchaVerdict = 'good' | 'bad';
export type CaptchaWorkerMode = 'proxyless' | 'external_proxy';

export type CaptchaProof = {
  provider: CaptchaProviderName;
  taskId: string;
  token: string;
  userAgent: string;
  durationMs: number;
  workerMode: CaptchaWorkerMode;
};

export type CaptchaProviderHealth = {
  provider: CaptchaProviderName;
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  balance: number | null;
  code: string | null;
};

export type CaptchaSolveOptions = {
  signal: AbortSignal;
  timeoutMs: number;
};

export interface CaptchaProviderAdapter {
  readonly name: CaptchaProviderName;
  readonly configured: boolean;
  solve(
    context: CaptchaChallengeContextV1,
    options: CaptchaSolveOptions,
  ): Promise<CaptchaProof>;
  report(proof: CaptchaProof, verdict: CaptchaVerdict, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<CaptchaProviderHealth>;
}

type CaptchaHttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  data?: unknown;
  params?: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  proxy: AxiosProxyConfig | false;
  headers?: Record<string, string>;
};

export type CaptchaHttpTransport = (request: CaptchaHttpRequest) => Promise<any>;

type WorkerProxy = {
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export class CaptchaProviderError extends Error {
  readonly provider: CaptchaProviderName;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    provider: CaptchaProviderName,
    code: string,
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = 'CaptchaProviderError';
    this.provider = provider;
    this.code = code;
    this.retryable = retryable;
  }
}

export class CaptchaWorkerProxyValidationError extends Error {
  readonly code = 'captcha_worker_proxy_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'CaptchaWorkerProxyValidationError';
  }
}

const defaultTransport: CaptchaHttpTransport = async (request) => {
  const response = await axios.request({
    method: request.method,
    url: request.url,
    data: request.data,
    params: request.params,
    signal: request.signal,
    timeout: request.timeoutMs,
    proxy: request.proxy,
    headers: request.headers,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
};

function parseApiProxy(raw = process.env.CAPTCHA_API_PROXY || ''): AxiosProxyConfig | false {
  const normalized = raw.trim();
  if (!normalized) return false;
  const parsed = new URL(normalized.includes('://') ? normalized : `http://${normalized}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CAPTCHA_API_PROXY only supports http:// or https:// URLs.');
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CAPTCHA_API_PROXY has an invalid host or port.');
  }
  const proxy: AxiosProxyConfig = {
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port,
  };
  if (parsed.username) {
    proxy.auth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password || ''),
    };
  }
  return proxy;
}

function isPrivateIpv4(host: string): boolean {
  const pieces = host.split('.').map(Number);
  if (pieces.length !== 4 || pieces.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = pieces;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isPrivateWorkerHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === '::1'
    || host === '::'
    || /^f[cd][0-9a-f]*:/i.test(host)
    || /^fe[89ab][0-9a-f]*:/i.test(host)
    || isPrivateIpv4(host);
}

export function resolveCaptchaWorkerProxy(
  raw = process.env.CAPTCHA_WORKER_PROXY || '',
): WorkerProxy | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized.includes('://') ? normalized : `http://${normalized}`);
  } catch {
    throw new CaptchaWorkerProxyValidationError('CAPTCHA_WORKER_PROXY is not a valid proxy URL.');
  }
  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
    throw new CaptchaWorkerProxyValidationError(
      'CAPTCHA_WORKER_PROXY must use http, https, socks4, or socks5.',
    );
  }
  if (!parsed.hostname || isPrivateWorkerHost(parsed.hostname)) {
    throw new CaptchaWorkerProxyValidationError(
      'CAPTCHA_WORKER_PROXY must be externally reachable; loopback and private proxies are rejected.',
    );
  }
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https'
      ? 443
      : protocol.startsWith('socks')
        ? 1080
        : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CaptchaWorkerProxyValidationError('CAPTCHA_WORKER_PROXY has an invalid port.');
  }
  return {
    protocol: protocol as WorkerProxy['protocol'],
    host: parsed.hostname,
    port,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

export function captchaProxyModes() {
  return {
    apiTransportMode: process.env.CAPTCHA_API_PROXY?.trim() ? 'proxy' as const : 'direct' as const,
    workerMode: process.env.CAPTCHA_WORKER_PROXY?.trim()
      ? 'external_proxy' as const
      : 'proxyless' as const,
  };
}

function timeoutController(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('captcha_provider_timeout')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function abortableCaptchaDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('captcha_cancelled'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), Math.max(0, milliseconds));
    const abort = () => finish(() => reject(signal.reason || new Error('captcha_cancelled')));
    const finish = (callback: (() => void)) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function providerCode(data: any, fallback: string): string {
  const value = data?.errorCode || data?.request || data?.code || fallback;
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 96);
}

function tokenFromSolution(solution: any): string {
  const value = solution?.gRecaptchaResponse
    || solution?.token
    || solution?.respKey
    || solution?.data;
  return typeof value === 'string' ? value.trim() : '';
}

function providerPollIntervalMs(): number {
  return Math.max(10, Math.min(5_000, Number(process.env.CAPTCHA_PROVIDER_POLL_MS) || 2_500));
}

const yesCaptchaUserAgents = new Map<string, { value: string; expiresAt: number }>();

function usableChromeUserAgent(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^Mozilla\/5\.0 .{1,300} Chrome\/\d{2,3}\.[^\s]+ Safari\/537\.36$/i.test(normalized)) {
    return '';
  }
  return normalized.slice(0, 512);
}

function yesTask(
  context: CaptchaChallengeContextV1,
  worker: WorkerProxy | null,
  userAgent = context.userAgent,
) {
  const task: Record<string, unknown> = {
    type: worker ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
    websiteURL: context.websiteURL,
    websiteKey: context.websiteKey,
    isInvisible: context.invisible,
    userAgent,
  };
  const enterprisePayload = context.enterprisePayload
    || (context.rqdata ? { rqdata: context.rqdata } : undefined);
  // YesCaptcha's documented HCaptchaTaskProxyless contract accepts rqdata as
  // a top-level string. Do not send undocumented enterprise objects that can
  // turn an otherwise valid task into ERROR_BAD_PARAMETERS.
  const rqdata = context.rqdata
    || (typeof enterprisePayload?.rqdata === 'string' ? enterprisePayload.rqdata : '');
  if (rqdata) task.rqdata = rqdata;
  if (worker) {
    task.proxyType = worker.protocol === 'https' ? 'http' : worker.protocol;
    task.proxyAddress = worker.host;
    task.proxyPort = worker.port;
    if (worker.username) task.proxyLogin = worker.username;
    if (worker.password) task.proxyPassword = worker.password;
  }
  return task;
}

function twoCaptchaProxy(worker: WorkerProxy): string {
  const credentials = worker.username
    ? `${encodeURIComponent(worker.username)}:${encodeURIComponent(worker.password || '')}@`
    : '';
  return `${credentials}${worker.host}:${worker.port}`;
}

abstract class BaseCaptchaProvider implements CaptchaProviderAdapter {
  abstract readonly name: CaptchaProviderName;
  abstract readonly configured: boolean;
  protected readonly transport: CaptchaHttpTransport;

  constructor(transport: CaptchaHttpTransport = defaultTransport) {
    this.transport = transport;
  }

  abstract solve(
    context: CaptchaChallengeContextV1,
    options: CaptchaSolveOptions,
  ): Promise<CaptchaProof>;
  abstract report(proof: CaptchaProof, verdict: CaptchaVerdict, signal?: AbortSignal): Promise<void>;
  abstract health(signal?: AbortSignal): Promise<CaptchaProviderHealth>;

  protected async request(
    request: Omit<CaptchaHttpRequest, 'proxy'>,
  ) {
    return this.transport({ ...request, proxy: parseApiProxy() });
  }
}

export class YesCaptchaProviderAdapter extends BaseCaptchaProvider {
  readonly name = 'yescaptcha' as const;
  private readonly clientKey: string;
  private readonly baseURL: string;

  constructor(options: {
    clientKey?: string;
    baseURL?: string;
    transport?: CaptchaHttpTransport;
  } = {}) {
    super(options.transport);
    const settings = getCaptchaSettingsSync();
    this.clientKey = String(options.clientKey ?? settings.yescaptchaKey ?? '').trim();
    this.baseURL = String(options.baseURL ?? settings.yescaptchaBaseUrl ?? 'https://api.yescaptcha.com')
      .replace(/\/$/, '');
  }

  get configured() { return Boolean(this.clientKey); }

  private async recommendedUserAgent(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const cached = yesCaptchaUserAgents.get(this.baseURL);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const response = await this.request({
        method: 'GET',
        url: `${this.baseURL}/useragent`,
        signal,
        timeoutMs: Math.min(10_000, timeoutMs),
      });
      const value = usableChromeUserAgent(response.data);
      if (response.status >= 200 && response.status < 300 && value) {
        yesCaptchaUserAgents.set(this.baseURL, {
          value,
          expiresAt: Date.now() + 10 * 60 * 1_000,
        });
        return value;
      }
    } catch {
      // A transient UA endpoint failure must not hide an otherwise healthy
      // configured provider; the browser-matched context UA remains usable.
    }
    return '';
  }

  async solve(context: CaptchaChallengeContextV1, options: CaptchaSolveOptions): Promise<CaptchaProof> {
    if (!this.configured) throw new CaptchaProviderError(this.name, 'provider_not_configured', 'YesCaptcha is not configured.', false);
    const started = Date.now();
    const deadline = timeoutController(options.signal, options.timeoutMs);
    try {
      const worker = resolveCaptchaWorkerProxy();
      // YesCaptcha explicitly publishes a current worker-compatible UA. The
      // previous random Safari/Firefox/Mac value was the dominant cause of
      // Suno hCaptcha jobs timing out before a token was produced.
      const recommendedUserAgent = await this.recommendedUserAgent(
        deadline.signal,
        options.timeoutMs,
      );
      const taskUserAgent = recommendedUserAgent || context.userAgent;
      const created = await this.request({
        method: 'POST',
        url: `${this.baseURL}/createTask`,
        data: { clientKey: this.clientKey, task: yesTask(context, worker, taskUserAgent) },
        signal: deadline.signal,
        timeoutMs: Math.min(20_000, options.timeoutMs),
        headers: { 'Content-Type': 'application/json' },
      });
      if (created.status >= 500 || created.data?.errorId) {
        throw new CaptchaProviderError(
          this.name,
          providerCode(created.data, 'create_task_failed'),
          'YesCaptcha could not create the hCaptcha task.',
        );
      }
      const taskId = String(created.data?.taskId || '').trim();
      let solution = created.data?.status === 'ready' ? created.data?.solution : null;
      let token = tokenFromSolution(solution);
      if (!taskId && !token) {
        throw new CaptchaProviderError(this.name, 'missing_task_id', 'YesCaptcha did not return a task id.');
      }
      while (!token) {
        await abortableCaptchaDelay(providerPollIntervalMs(), deadline.signal);
        const result = await this.request({
          method: 'POST',
          url: `${this.baseURL}/getTaskResult`,
          data: { clientKey: this.clientKey, taskId },
          signal: deadline.signal,
          timeoutMs: Math.min(15_000, options.timeoutMs),
          headers: { 'Content-Type': 'application/json' },
        });
        if (result.status >= 500 || result.data?.errorId) {
          throw new CaptchaProviderError(
            this.name,
            providerCode(result.data, 'task_result_failed'),
            'YesCaptcha could not complete the hCaptcha task.',
          );
        }
        if (result.data?.status === 'ready') {
          solution = result.data?.solution;
          token = tokenFromSolution(solution);
        }
      }
      if (!token) throw new CaptchaProviderError(this.name, 'empty_token', 'YesCaptcha returned an empty token.');
      return {
        provider: this.name,
        taskId: taskId || 'synchronous',
        token,
        userAgent: typeof solution?.userAgent === 'string' && solution.userAgent.trim()
          ? solution.userAgent.trim()
          : taskUserAgent,
        durationMs: Date.now() - started,
        workerMode: worker ? 'external_proxy' : 'proxyless',
      };
    } catch (error: any) {
      if (error instanceof CaptchaProviderError || error instanceof CaptchaWorkerProxyValidationError) throw error;
      if (deadline.signal.aborted) {
        throw new CaptchaProviderError(this.name, 'provider_timeout', 'YesCaptcha timed out or was cancelled.');
      }
      throw new CaptchaProviderError(this.name, 'provider_transport_error', 'YesCaptcha API transport failed.');
    } finally {
      deadline.cleanup();
    }
  }

  async report(proof: CaptchaProof, verdict: CaptchaVerdict, signal?: AbortSignal): Promise<void> {
    if (!this.configured || proof.provider !== this.name || proof.taskId === 'synchronous') return;
    const deadline = timeoutController(signal, 8_000);
    try {
      await this.request({
        method: 'POST',
        url: `${this.baseURL}/${verdict === 'good' ? 'reportCorrect' : 'reportIncorrect'}`,
        data: { clientKey: this.clientKey, taskId: proof.taskId },
        signal: deadline.signal,
        timeoutMs: 8_000,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      deadline.cleanup();
    }
  }

  async health(signal?: AbortSignal): Promise<CaptchaProviderHealth> {
    const started = Date.now();
    if (!this.configured) return { provider: this.name, configured: false, reachable: false, latencyMs: null, balance: null, code: 'provider_not_configured' };
    const deadline = timeoutController(signal, 8_000);
    try {
      const result = await this.request({
        method: 'POST',
        url: `${this.baseURL}/getBalance`,
        data: { clientKey: this.clientKey },
        signal: deadline.signal,
        timeoutMs: 8_000,
        headers: { 'Content-Type': 'application/json' },
      });
      const reachable = result.status < 500 && !result.data?.errorId;
      return {
        provider: this.name,
        configured: true,
        reachable,
        latencyMs: Date.now() - started,
        balance: reachable ? Number(result.data?.balance ?? 0) : null,
        code: reachable ? null : providerCode(result.data, 'provider_unreachable'),
      };
    } catch {
      return { provider: this.name, configured: true, reachable: false, latencyMs: Date.now() - started, balance: null, code: 'provider_unreachable' };
    } finally {
      deadline.cleanup();
    }
  }
}

export class TwoCaptchaProviderAdapter extends BaseCaptchaProvider {
  readonly name = '2captcha' as const;
  private readonly clientKey: string;
  private readonly baseURL: string;

  constructor(options: {
    clientKey?: string;
    baseURL?: string;
    transport?: CaptchaHttpTransport;
  } = {}) {
    super(options.transport);
    this.clientKey = String(options.clientKey ?? getCaptchaSettingsSync().twocaptchaKey ?? '').trim();
    this.baseURL = String(options.baseURL ?? 'https://2captcha.com').replace(/\/$/, '');
  }

  get configured() { return Boolean(this.clientKey); }

  async solve(context: CaptchaChallengeContextV1, options: CaptchaSolveOptions): Promise<CaptchaProof> {
    if (!this.configured) throw new CaptchaProviderError(this.name, 'provider_not_configured', '2Captcha is not configured.', false);
    const started = Date.now();
    const deadline = timeoutController(options.signal, options.timeoutMs);
    try {
      const worker = resolveCaptchaWorkerProxy();
      const submit = new URLSearchParams({
        key: this.clientKey,
        method: 'hcaptcha',
        pageurl: context.websiteURL,
        sitekey: context.websiteKey,
        invisible: context.invisible ? '1' : '0',
        userAgent: context.userAgent,
        json: '1',
      });
      if (context.rqdata) submit.set('data', context.rqdata);
      if (worker) {
        submit.set('proxy', twoCaptchaProxy(worker));
        submit.set('proxytype', worker.protocol.toUpperCase());
      }
      const created = await this.request({
        method: 'POST',
        url: `${this.baseURL}/in.php`,
        data: submit.toString(),
        signal: deadline.signal,
        timeoutMs: Math.min(20_000, options.timeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (created.status >= 500 || Number(created.data?.status) !== 1) {
        throw new CaptchaProviderError(
          this.name,
          providerCode(created.data, 'create_task_failed'),
          '2Captcha could not create the hCaptcha task.',
        );
      }
      const taskId = String(created.data?.request || '').trim();
      if (!taskId) throw new CaptchaProviderError(this.name, 'missing_task_id', '2Captcha did not return a task id.');
      let token = '';
      while (!token) {
        await abortableCaptchaDelay(providerPollIntervalMs(), deadline.signal);
        const result = await this.request({
          method: 'GET',
          url: `${this.baseURL}/res.php`,
          params: { key: this.clientKey, action: 'get', id: taskId, json: 1 },
          signal: deadline.signal,
          timeoutMs: Math.min(15_000, options.timeoutMs),
        });
        if (Number(result.data?.status) === 1) token = String(result.data?.request || '').trim();
        else if (String(result.data?.request || '').toUpperCase() !== 'CAPCHA_NOT_READY') {
          throw new CaptchaProviderError(
            this.name,
            providerCode(result.data, 'task_result_failed'),
            '2Captcha could not complete the hCaptcha task.',
          );
        }
      }
      return {
        provider: this.name,
        taskId,
        token,
        userAgent: context.userAgent,
        durationMs: Date.now() - started,
        workerMode: worker ? 'external_proxy' : 'proxyless',
      };
    } catch (error: any) {
      if (error instanceof CaptchaProviderError || error instanceof CaptchaWorkerProxyValidationError) throw error;
      if (deadline.signal.aborted) {
        throw new CaptchaProviderError(this.name, 'provider_timeout', '2Captcha timed out or was cancelled.');
      }
      throw new CaptchaProviderError(this.name, 'provider_transport_error', '2Captcha API transport failed.');
    } finally {
      deadline.cleanup();
    }
  }

  async report(proof: CaptchaProof, verdict: CaptchaVerdict, signal?: AbortSignal): Promise<void> {
    if (!this.configured || proof.provider !== this.name) return;
    const deadline = timeoutController(signal, 8_000);
    try {
      await this.request({
        method: 'GET',
        url: `${this.baseURL}/res.php`,
        params: {
          key: this.clientKey,
          action: verdict === 'good' ? 'reportgood' : 'reportbad',
          id: proof.taskId,
          json: 1,
        },
        signal: deadline.signal,
        timeoutMs: 8_000,
      });
    } finally {
      deadline.cleanup();
    }
  }

  async health(signal?: AbortSignal): Promise<CaptchaProviderHealth> {
    const started = Date.now();
    if (!this.configured) return { provider: this.name, configured: false, reachable: false, latencyMs: null, balance: null, code: 'provider_not_configured' };
    const deadline = timeoutController(signal, 8_000);
    try {
      const result = await this.request({
        method: 'GET',
        url: `${this.baseURL}/res.php`,
        params: { key: this.clientKey, action: 'getbalance', json: 1 },
        signal: deadline.signal,
        timeoutMs: 8_000,
      });
      const reachable = result.status < 500 && Number(result.data?.status) === 1;
      return {
        provider: this.name,
        configured: true,
        reachable,
        latencyMs: Date.now() - started,
        balance: reachable ? Number(result.data?.request ?? 0) : null,
        code: reachable ? null : providerCode(result.data, 'provider_unreachable'),
      };
    } catch {
      return { provider: this.name, configured: true, reachable: false, latencyMs: Date.now() - started, balance: null, code: 'provider_unreachable' };
    } finally {
      deadline.cleanup();
    }
  }
}

export function configuredCaptchaProviders(): CaptchaProviderAdapter[] {
  const settings = getCaptchaSettingsSync();
  const yes = new YesCaptchaProviderAdapter();
  const two = new TwoCaptchaProviderAdapter();
  const preferred = settings.provider === '2captcha' ? [two, yes] : [yes, two];
  return preferred.filter((provider) => provider.configured);
}
