import type { CaptchaChallengeContextV1 } from '@/lib/captcha-challenge';
import {
  CaptchaProof,
  CaptchaProviderAdapter,
  CaptchaProviderHealth,
  CaptchaProviderName,
  CaptchaVerdict,
  configuredCaptchaProviders,
} from '@/lib/captcha-provider';

type ProviderMetrics = {
  apiState: 'unchecked' | 'reachable' | 'unreachable';
  apiCheckedAt: string | null;
  apiLatencyMs: number | null;
  apiCode: string | null;
  attempts: number;
  tokensReturned: number;
  timeouts: number;
  failures: number;
  totalDurationMs: number;
  sunoAccepted: number;
  sunoRejected: number;
  sunoIndeterminate: number;
  reportsGood: number;
  reportsBad: number;
  reportsFailed: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastCode: string | null;
  lastAttemptAt: string | null;
  lastDurationMs: number | null;
};

type GateWaiter = {
  accountKey: string;
  signal?: AbortSignal;
  abort?: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type CaptchaCoordinatorSession = {
  solve(
    context: CaptchaChallengeContextV1,
    providers?: CaptchaProviderAdapter[],
  ): Promise<CaptchaProof>;
  report(proof: CaptchaProof, verdict: CaptchaVerdict): Promise<void>;
  recordIndeterminate(proof: CaptchaProof): void;
};

export class CaptchaCoordinatorBusyError extends Error {
  readonly code = 'captcha_coordinator_busy';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 5) {
    super('CAPTCHA coordination is temporarily busy.');
    this.name = 'CaptchaCoordinatorBusyError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class CaptchaProvidersUnavailableError extends Error {
  readonly code = 'captcha_providers_unavailable';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, readonly providerCodes: string[]) {
    super('Configured CAPTCHA providers could not return a usable token.');
    this.name = 'CaptchaProvidersUnavailableError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class CaptchaCoordinator {
  private readonly maxConcurrent: number;
  private readonly failureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly accountCooldownMs: number;
  private readonly primaryTimeoutMs: number;
  private readonly fallbackTimeoutMs: number;
  private readonly now: () => number;
  private active = 0;
  private activeAccounts = new Set<string>();
  private accountCooldowns = new Map<string, number>();
  private proofProviders = new Map<string, CaptchaProviderAdapter>();
  private waiters: GateWaiter[] = [];
  private startedAt = new Date().toISOString();
  private metrics: Record<CaptchaProviderName, ProviderMetrics> = {
    yescaptcha: this.emptyMetrics(),
    '2captcha': this.emptyMetrics(),
  };

  constructor(options: {
    maxConcurrent?: number;
    failureThreshold?: number;
    circuitCooldownMs?: number;
    accountCooldownMs?: number;
    primaryTimeoutMs?: number;
    fallbackTimeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.maxConcurrent = Math.max(
      1,
      Math.min(8, Number(options.maxConcurrent ?? process.env.CAPTCHA_MAX_CONCURRENT ?? 2) || 2),
    );
    this.failureThreshold = Math.max(1, Number(options.failureThreshold ?? 3) || 3);
    this.circuitCooldownMs = Math.max(1_000, Number(options.circuitCooldownMs ?? 90_000) || 90_000);
    this.accountCooldownMs = Math.max(1_000, Number(options.accountCooldownMs ?? 30_000) || 30_000);
    this.primaryTimeoutMs = Math.max(1_000, Number(options.primaryTimeoutMs ?? 75_000) || 75_000);
    this.fallbackTimeoutMs = Math.max(1_000, Number(options.fallbackTimeoutMs ?? 60_000) || 60_000);
    this.now = options.now || Date.now;
  }

  private emptyMetrics(): ProviderMetrics {
    return {
      apiState: 'unchecked',
      apiCheckedAt: null,
      apiLatencyMs: null,
      apiCode: null,
      attempts: 0,
      tokensReturned: 0,
      timeouts: 0,
      failures: 0,
      totalDurationMs: 0,
      sunoAccepted: 0,
      sunoRejected: 0,
      sunoIndeterminate: 0,
      reportsGood: 0,
      reportsBad: 0,
      reportsFailed: 0,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      lastCode: null,
      lastAttemptAt: null,
      lastDurationMs: null,
    };
  }

  isAccountBlocked(accountKey: string): boolean {
    const key = String(accountKey || '').trim();
    if (!key) return false;
    const cooldown = this.accountCooldowns.get(key) || 0;
    if (cooldown && cooldown <= this.now()) this.accountCooldowns.delete(key);
    return this.activeAccounts.has(key) || cooldown > this.now();
  }

  retryAfterSeconds(accountKey?: string): number {
    const now = this.now();
    const accountUntil = accountKey ? this.accountCooldowns.get(accountKey) || 0 : 0;
    const providerUntil = Math.min(
      ...Object.values(this.metrics)
        .map((item) => item.circuitOpenUntil)
        .filter((value) => value > now),
    );
    const until = Math.max(accountUntil, Number.isFinite(providerUntil) ? providerUntil : 0);
    return Math.max(5, Math.ceil((until - now) / 1000));
  }

  recordProviderHealth(health: CaptchaProviderHealth): void {
    const metric = this.metrics[health.provider];
    metric.apiState = health.reachable ? 'reachable' : 'unreachable';
    metric.apiCheckedAt = new Date(this.now()).toISOString();
    metric.apiLatencyMs = health.latencyMs;
    metric.apiCode = health.code;
  }

  async run<T>(
    accountKey: string,
    signal: AbortSignal,
    operation: (session: CaptchaCoordinatorSession) => Promise<T>,
  ): Promise<T> {
    const key = String(accountKey || 'direct-cookie').trim() || 'direct-cookie';
    await this.acquire(key, signal);
    let solved = false;
    const session: CaptchaCoordinatorSession = {
      solve: async (context, providers = configuredCaptchaProviders()) => {
        try {
          const proof = await this.solveWithFallback(context, providers, signal);
          solved = true;
          return proof;
        } catch (error) {
          this.accountCooldowns.set(key, this.now() + this.accountCooldownMs);
          throw error;
        }
      },
      report: (proof, verdict) => this.report(proof, verdict, signal),
      recordIndeterminate: (proof) => {
        this.metrics[proof.provider].sunoIndeterminate += 1;
      },
    };
    try {
      const result = await operation(session);
      if (solved) this.accountCooldowns.delete(key);
      return result;
    } catch (error: any) {
      if (String(error?.code || '').startsWith('suno_captcha_')) {
        this.accountCooldowns.set(key, this.now() + this.accountCooldownMs);
      }
      throw error;
    } finally {
      this.release(key);
    }
  }

  private canAcquire(accountKey: string): boolean {
    return this.active < this.maxConcurrent
      && !this.activeAccounts.has(accountKey)
      && (this.accountCooldowns.get(accountKey) || 0) <= this.now();
  }

  private async acquire(accountKey: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason || new CaptchaCoordinatorBusyError();
    const cooldownUntil = this.accountCooldowns.get(accountKey) || 0;
    if (cooldownUntil > this.now()) {
      throw new CaptchaCoordinatorBusyError((cooldownUntil - this.now()) / 1000);
    }
    if (this.canAcquire(accountKey) && this.waiters.length === 0) {
      this.active += 1;
      this.activeAccounts.add(accountKey);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {} as GateWaiter;
      const finish = (callback: () => void) => {
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        callback();
      };
      waiter.accountKey = accountKey;
      waiter.signal = signal;
      waiter.resolve = () => finish(() => {
        this.active += 1;
        this.activeAccounts.add(accountKey);
        resolve();
      });
      waiter.reject = (error) => finish(() => reject(error));
      if (signal) {
        waiter.abort = () => waiter.reject(signal.reason || new CaptchaCoordinatorBusyError());
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private release(accountKey: string): void {
    if (this.activeAccounts.delete(accountKey)) this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    let progressed = true;
    while (progressed && this.active < this.maxConcurrent) {
      progressed = false;
      for (const waiter of [...this.waiters]) {
        if (waiter.signal?.aborted) {
          waiter.reject(waiter.signal.reason || new CaptchaCoordinatorBusyError());
          progressed = true;
          continue;
        }
        if (!this.canAcquire(waiter.accountKey)) continue;
        waiter.resolve();
        progressed = true;
        break;
      }
    }
  }

  private providerAvailable(provider: CaptchaProviderAdapter): boolean {
    const metric = this.metrics[provider.name];
    if (metric.circuitOpenUntil && metric.circuitOpenUntil <= this.now()) {
      metric.circuitOpenUntil = 0;
      metric.consecutiveFailures = Math.max(0, this.failureThreshold - 1);
    }
    return provider.configured && metric.circuitOpenUntil <= this.now();
  }

  private async solveWithFallback(
    context: CaptchaChallengeContextV1,
    providers: CaptchaProviderAdapter[],
    signal: AbortSignal,
  ): Promise<CaptchaProof> {
    const uniqueProviders = providers.filter((provider, index, list) => (
      list.findIndex((item) => item.name === provider.name) === index
    ));
    const candidates: CaptchaProviderAdapter[] = [];
    const errors: string[] = [];
    for (const provider of uniqueProviders) {
      if (!provider.configured) {
        errors.push(`${provider.name}:provider_not_configured`);
      } else if (!this.providerAvailable(provider)) {
        errors.push(`${provider.name}:circuit_open`);
      } else {
        candidates.push(provider);
      }
    }
    for (let index = 0; index < Math.min(2, candidates.length); index += 1) {
      const provider = candidates[index];
      const metric = this.metrics[provider.name];
      const started = this.now();
      metric.attempts += 1;
      metric.lastAttemptAt = new Date(started).toISOString();
      try {
        const proof = await provider.solve(context, {
          signal,
          timeoutMs: index === 0 ? this.primaryTimeoutMs : this.fallbackTimeoutMs,
        });
        metric.tokensReturned += 1;
        metric.totalDurationMs += Math.max(0, proof.durationMs || this.now() - started);
        metric.consecutiveFailures = 0;
        metric.circuitOpenUntil = 0;
        metric.lastCode = null;
        metric.lastDurationMs = Math.max(0, this.now() - started);
        this.proofProviders.set(`${proof.provider}:${proof.taskId}`, provider);
        return proof;
      } catch (error: any) {
        const code = String(error?.code || 'provider_failed')
          .replace(/[^a-zA-Z0-9_-]+/g, '_')
          .slice(0, 96);
        errors.push(`${provider.name}:${code}`);
        metric.failures += 1;
        const durationMs = Math.max(0, this.now() - started);
        metric.totalDurationMs += durationMs;
        metric.lastCode = code;
        metric.lastDurationMs = durationMs;
        if (code.includes('timeout') || signal.aborted) metric.timeouts += 1;
        metric.consecutiveFailures += 1;
        if (metric.consecutiveFailures >= this.failureThreshold) {
          metric.circuitOpenUntil = this.now() + this.circuitCooldownMs;
        }
        if (signal.aborted) throw error;
      }
    }
    throw new CaptchaProvidersUnavailableError(this.retryAfterSeconds(), errors);
  }

  private async report(
    proof: CaptchaProof,
    verdict: CaptchaVerdict,
    signal: AbortSignal,
  ): Promise<void> {
    const metric = this.metrics[proof.provider];
    if (verdict === 'good') metric.sunoAccepted += 1;
    else metric.sunoRejected += 1;
    const proofKey = `${proof.provider}:${proof.taskId}`;
    const provider = this.proofProviders.get(proofKey)
      || configuredCaptchaProviders().find((item) => item.name === proof.provider);
    if (!provider) return;
    try {
      await provider.report(proof, verdict, signal);
      if (verdict === 'good') metric.reportsGood += 1;
      else metric.reportsBad += 1;
    } catch {
      metric.reportsFailed += 1;
    } finally {
      this.proofProviders.delete(proofKey);
    }
  }

  snapshot() {
    const now = this.now();
    const providers = Object.fromEntries(
      (Object.entries(this.metrics) as Array<[CaptchaProviderName, ProviderMetrics]>).map(([name, metric]) => [
        name,
        {
          api: {
            state: metric.apiState,
            checkedAt: metric.apiCheckedAt,
            latencyMs: metric.apiLatencyMs,
            code: metric.apiCode,
          },
          solve: {
            attempts: metric.attempts,
            tokensReturned: metric.tokensReturned,
            timeouts: metric.timeouts,
            failures: metric.failures,
            averageDurationMs: metric.attempts
              ? Math.round(metric.totalDurationMs / metric.attempts)
              : null,
            lastCode: metric.lastCode,
            lastAttemptAt: metric.lastAttemptAt,
            lastDurationMs: metric.lastDurationMs,
          },
          suno: {
            accepted: metric.sunoAccepted,
            captchaRejected: metric.sunoRejected,
            indeterminate: metric.sunoIndeterminate,
          },
          reports: {
            good: metric.reportsGood,
            bad: metric.reportsBad,
            failed: metric.reportsFailed,
          },
          circuit: {
            state: metric.circuitOpenUntil > now ? 'open' : 'closed',
            retryAfterSeconds: metric.circuitOpenUntil > now
              ? Math.ceil((metric.circuitOpenUntil - now) / 1000)
              : 0,
          },
        },
      ]),
    );
    return {
      schemaVersion: 'captcha-status/v2',
      startedAt: this.startedAt,
      active: this.active,
      limit: this.maxConcurrent,
      busyAccounts: this.activeAccounts.size,
      waiting: this.waiters.length,
      providers,
    };
  }

  resetForTests(): void {
    for (const waiter of [...this.waiters]) waiter.reject(new CaptchaCoordinatorBusyError());
    this.active = 0;
    this.activeAccounts.clear();
    this.accountCooldowns.clear();
    this.proofProviders.clear();
    this.metrics = { yescaptcha: this.emptyMetrics(), '2captcha': this.emptyMetrics() };
    this.startedAt = new Date().toISOString();
  }
}

const globalRuntime = globalThis as typeof globalThis & {
  __sunoCaptchaCoordinator?: CaptchaCoordinator;
};

export function getCaptchaCoordinator(): CaptchaCoordinator {
  if (!globalRuntime.__sunoCaptchaCoordinator) {
    globalRuntime.__sunoCaptchaCoordinator = new CaptchaCoordinator();
  }
  return globalRuntime.__sunoCaptchaCoordinator;
}
