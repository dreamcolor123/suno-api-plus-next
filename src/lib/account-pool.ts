import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export type AccountTier = 'basic' | 'super' | 'heavy';
export type AccountStatus = 'active' | 'cooling' | 'expired' | 'disabled';

type QuotaSnapshot = {
  credits_left?: number;
  period?: string;
  monthly_limit?: number;
  monthly_usage?: number;
};

type StoredAccount = {
  id: string;
  name: string;
  tier: AccountTier;
  cookie: string;
  enabled: boolean;
  status: AccountStatus;
  priority: number;
  maxConcurrent: number;
  creditsLeft: number | null;
  period: string | null;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  health: number;
  failures: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastQuotaSync: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountView = Omit<StoredAccount, 'cookie'> & {
  cookieConfigured: boolean;
  inflight: number;
};

export class AccountAffinityUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'account_affinity_unavailable';
  readonly retryAfterSeconds = 30;

  constructor(message = 'The account bound to this source clip is unavailable or its login has expired.') {
    super(message);
    this.name = 'AccountAffinityUnavailableError';
  }
}

export class AccountAffinityBusyError extends Error {
  readonly status = 429;
  readonly code: string = 'account_affinity_busy';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 5) {
    super('The account bound to this source clip is busy; the request was not submitted.');
    this.name = 'AccountAffinityBusyError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 5));
  }
}

export class AccountAffinityQueueFullError extends AccountAffinityBusyError {
  readonly code = 'account_affinity_queue_full';

  constructor() {
    super(10);
    this.name = 'AccountAffinityQueueFullError';
    this.message = 'The account-bound post-processing wait queue is full; the request was not submitted.';
  }
}

export class AccountPoolCapacityError extends Error {
  readonly status = 429;
  readonly code = 'account_pool_busy';
  readonly retryAfterSeconds = 5;
  readonly tier: AccountTier;

  constructor(tier: AccountTier) {
    super(`All eligible ${tier} accounts are temporarily busy.`);
    this.name = 'AccountPoolCapacityError';
    this.tier = tier;
  }
}

export class AccountPoolCredentialsUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'account_pool_credentials_unavailable';
  readonly retryAfterSeconds = 30;
  readonly tier: AccountTier;

  constructor(tier: AccountTier) {
    super(
      `The ${tier} account pool credentials are unavailable. `
      + 'Check ACCOUNT_ENCRYPTION_KEY and retry.',
    );
    this.name = 'AccountPoolCredentialsUnavailableError';
    this.tier = tier;
  }
}

export class AccountPoolUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'account_pool_unavailable';
  readonly retryAfterSeconds = 30;
  readonly tier: AccountTier;

  constructor(tier: AccountTier) {
    super(`No eligible ${tier} account is currently configured in the account pool.`);
    this.name = 'AccountPoolUnavailableError';
    this.tier = tier;
  }
}

type AccountFile = {
  version: 1;
  accounts: StoredAccount[];
};

type PoolLease = {
  account: StoredAccount;
  cookie: string;
  release: (error?: unknown) => Promise<void>;
};

type QueueWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

export type AffinityWaitOptions = {
  maxWaitMs?: number;
  signal?: AbortSignal;
};

const poolOrder: Record<AccountTier, AccountTier[]> = {
  basic: ['basic', 'super', 'heavy'],
  super: ['super', 'heavy'],
  heavy: ['heavy'],
};

const defaultConcurrency: Record<AccountTier, number> = {
  basic: 1,
  super: 1,
  heavy: 2,
};

function nowIso() {
  return new Date().toISOString();
}

function dataPath() {
  return process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json');
}

function encryptionKey() {
  const source = process.env.ACCOUNT_ENCRYPTION_KEY || process.env.ADMIN_PASSWORD;
  if (!source) throw new Error('ACCOUNT_ENCRYPTION_KEY is not configured.');
  return crypto.createHash('sha256').update(source).digest();
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted cookie payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function normalizeTier(value: unknown): AccountTier {
  return value === 'super' || value === 'heavy' ? value : 'basic';
}

export function accountTier(value: unknown): AccountTier {
  return normalizeTier(value);
}

function errorDetails(error: any) {
  const status = Number(error?.response?.status || 0);
  const message = String(
    error?.response?.data?.detail || error?.response?.data?.error || error?.message || 'Unknown account error',
  );
  return { status, message, lower: message.toLowerCase() };
}

function shouldPenalizeAccount(error: any) {
  if (error?.recordAccountFailure === false) return false;
  if (String(error?.code || '').startsWith('suno_captcha_')) return false;
  const details = errorDetails(error);
  // Request/permission validation says nothing about account health. Cooling
  // an account for a clip it does not own makes portable-clip probing poison
  // the pool and can hide otherwise healthy accounts.
  if (details.status >= 400 && details.status < 500
    && ![401, 402, 408, 429].includes(details.status)) return false;
  return true;
}

class AccountPool {
  private accounts: StoredAccount[] = [];
  private inflight = new Map<string, number>();
  private affinityWaiters = new Map<string, QueueWaiter[]>();
  private longWaiters = new Map<string, QueueWaiter[]>();
  private longActive = new Set<string>();
  private loaded = false;
  private loading?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private refreshPromise?: Promise<{ refreshed: number; failed: number }>;
  private lastRefreshSweep = 0;

  private queueLimit() {
    return Math.max(1, Math.min(16, Number(process.env.ACCOUNT_AFFINITY_QUEUE_LIMIT) || 8));
  }

  private waitMilliseconds(value: unknown, fallback: number) {
    return Math.max(1, Math.min(fallback, Number(value) || fallback));
  }

  private boundAccount(tier: AccountTier, accountId: string): StoredAccount | undefined {
    const normalized = String(accountId || '').trim();
    const account = this.accounts.find((item) => item.id === normalized);
    if (!account || !poolOrder[tier].includes(account.tier)) return undefined;
    return account;
  }

  private accountCanLease(account: StoredAccount) {
    const now = Date.now();
    return account.enabled
      && account.status === 'active'
      && account.creditsLeft !== 0
      && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= now)
      && (this.inflight.get(account.id) || 0) < account.maxConcurrent;
  }

  private clearWaiter(waiters: Map<string, QueueWaiter[]>, key: string, waiter: QueueWaiter) {
    const queue = waiters.get(key);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) waiters.delete(key);
  }

  private wakeQueue(waiters: Map<string, QueueWaiter[]>, key: string, canWake: () => boolean) {
    const queue = waiters.get(key);
    if (!queue || !queue.length || !canWake()) return;
    const waiter = queue.shift()!;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    if (!queue.length) waiters.delete(key);
    waiter.resolve();
  }

  private rejectQueue(waiters: Map<string, QueueWaiter[]>, key: string, error: unknown) {
    const queue = waiters.get(key) || [];
    waiters.delete(key);
    for (const waiter of queue) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
    }
  }

  private enqueue(
    waiters: Map<string, QueueWaiter[]>,
    key: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    timeoutError: () => Error,
  ): Promise<void> {
    const queue = waiters.get(key) || [];
    if (queue.length >= this.queueLimit()) return Promise.reject(new AccountAffinityQueueFullError());
    return new Promise<void>((resolve, reject) => {
      const waiter = {} as QueueWaiter;
      const finish = (callback: () => void) => {
        clearTimeout(waiter.timer);
        if (signal && waiter.abort) signal.removeEventListener('abort', waiter.abort);
        this.clearWaiter(waiters, key, waiter);
        callback();
      };
      waiter.resolve = () => finish(resolve);
      waiter.reject = (error) => finish(() => reject(error));
      waiter.timer = setTimeout(() => waiter.reject(timeoutError()), timeoutMs);
      waiter.signal = signal;
      if (signal) {
        waiter.abort = () => waiter.reject(new AccountAffinityBusyError(1));
        if (signal.aborted) {
          waiter.reject(new AccountAffinityBusyError(1));
          return;
        }
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      queue.push(waiter);
      waiters.set(key, queue);
    });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const file = dataPath();
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as AccountFile;
        this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        this.accounts = [];
      }
      this.loaded = true;
    })();
    return this.loading;
  }

  private async persist() {
    const snapshot: AccountFile = { version: 1, accounts: this.accounts };
    const file = dataPath();
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    return this.writeQueue;
  }

  private view(account: StoredAccount): AccountView {
    const { cookie, ...safe } = account;
    return {
      ...safe,
      cookieConfigured: Boolean(cookie),
      inflight: this.inflight.get(account.id) || 0,
    };
  }

  async list() {
    await this.ensureLoaded();
    this.restoreCooledAccounts();
    return this.accounts.map((account) => this.view(account));
  }

  async hasStoredAccounts() {
    await this.ensureLoaded();
    return this.accounts.some((account) => account.enabled && account.status !== 'expired');
  }

  async add(input: { name?: unknown; tier?: unknown; cookie?: unknown; priority?: unknown; maxConcurrent?: unknown }) {
    await this.ensureLoaded();
    const cookie = typeof input.cookie === 'string' ? input.cookie.trim() : '';
    if (!cookie.includes('__client')) throw new Error('The Suno cookie must contain __client.');
    const tier = normalizeTier(input.tier);
    const timestamp = nowIso();
    const account: StoredAccount = {
      id: crypto.randomUUID(),
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `Suno ${tier}`,
      tier,
      cookie: encrypt(cookie),
      enabled: true,
      status: 'active',
      priority: Math.max(-100, Math.min(100, Number(input.priority) || 0)),
      maxConcurrent: Math.max(1, Math.min(4, Number(input.maxConcurrent) || defaultConcurrency[tier])),
      creditsLeft: null,
      period: null,
      monthlyLimit: null,
      monthlyUsage: null,
      health: 1,
      failures: 0,
      cooldownUntil: null,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastQuotaSync: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.accounts.push(account);
    await this.persist();
    return this.view(account);
  }

  async update(id: string, input: Record<string, unknown>) {
    await this.ensureLoaded();
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new Error('Account not found.');
    if (typeof input.name === 'string' && input.name.trim()) account.name = input.name.trim();
    if (input.tier) account.tier = normalizeTier(input.tier);
    if (typeof input.enabled === 'boolean') {
      account.enabled = input.enabled;
      account.status = input.enabled ? 'active' : 'disabled';
      if (input.enabled) account.cooldownUntil = null;
      if (!input.enabled) {
        this.rejectQueue(this.affinityWaiters, account.id, new AccountAffinityUnavailableError());
        this.rejectQueue(this.longWaiters, `account:${account.id}`, new AccountAffinityUnavailableError());
      }
    }
    if (input.priority !== undefined) account.priority = Math.max(-100, Math.min(100, Number(input.priority) || 0));
    if (input.maxConcurrent !== undefined) account.maxConcurrent = Math.max(1, Math.min(4, Number(input.maxConcurrent) || 1));
    if (typeof input.cookie === 'string' && input.cookie.trim()) {
      if (!input.cookie.includes('__client')) throw new Error('The Suno cookie must contain __client.');
      account.cookie = encrypt(input.cookie.trim());
      account.status = account.enabled ? 'active' : 'disabled';
      account.failures = 0;
      account.health = 1;
      account.cooldownUntil = null;
      account.lastError = null;
    }
    account.updatedAt = nowIso();
    await this.persist();
    return this.view(account);
  }

  async remove(id: string) {
    await this.ensureLoaded();
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    this.inflight.delete(id);
    this.rejectQueue(this.affinityWaiters, id, new AccountAffinityUnavailableError());
    this.rejectQueue(this.longWaiters, `account:${id}`, new AccountAffinityUnavailableError());
    if (this.accounts.length === before) throw new Error('Account not found.');
    await this.persist();
  }

  private restoreCooledAccounts() {
    const now = Date.now();
    for (const account of this.accounts) {
      if (account.enabled && account.status === 'cooling' && account.cooldownUntil && Date.parse(account.cooldownUntil) <= now && account.creditsLeft !== 0) {
        account.status = 'active';
        account.cooldownUntil = null;
      }
    }
  }

  private score(account: StoredAccount) {
    const inflight = this.inflight.get(account.id) || 0;
    const quotaRatio = account.creditsLeft === null || !account.monthlyLimit
      ? 0.5
      : Math.max(0, Math.min(1, account.creditsLeft / account.monthlyLimit));
    const lastUsed = account.lastUsedAt ? Date.parse(account.lastUsedAt) : 0;
    const ageSeconds = lastUsed ? (Date.now() - lastUsed) / 1000 : 120;
    const recentPenalty = ageSeconds < 90 ? (1 - ageSeconds / 90) * 20 : 0;
    return (
      account.health * 100
      + quotaRatio * 25
      + account.priority
      - inflight * 24
      - Math.min(account.failures, 10) * 5
      - recentPenalty
    );
  }

  private hasTemporarilyBusyAccount(
    tier: AccountTier,
    exclude: Set<string>,
    exclusive = false,
  ) {
    const now = Date.now();
    return this.accounts.some((account) => {
      const inflight = this.inflight.get(account.id) || 0;
      return poolOrder[tier].includes(account.tier)
        && account.enabled
        && account.status === 'active'
        && account.creditsLeft !== 0
        && !exclude.has(account.id)
        && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= now)
        && (exclusive ? inflight > 0 : inflight >= account.maxConcurrent);
    });
  }

  private async acquire(
    tier: AccountTier,
    exclude: Set<string>,
    requiredAccountId?: string,
    exclusive = false,
  ): Promise<PoolLease | null> {
    await this.ensureLoaded();
    this.restoreCooledAccounts();
    const now = Date.now();
    let credentialFailure = false;
    for (const candidateTier of poolOrder[tier]) {
      const candidates = this.accounts
        .filter((account) => {
          const inflight = this.inflight.get(account.id) || 0;
          return account.tier === candidateTier
            && (!requiredAccountId || account.id === requiredAccountId)
            && account.enabled
            && account.status === 'active'
            && account.creditsLeft !== 0
            && !exclude.has(account.id)
            && (exclusive ? inflight === 0 : inflight < account.maxConcurrent)
            && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= now);
        })
        .sort((left, right) => this.score(right) - this.score(left));

      for (const account of candidates) {
        let cookie: string;
        try {
          cookie = decrypt(account.cookie);
        } catch {
          // A missing or mismatched process key is a deployment/configuration
          // failure, not evidence that the stored account itself is invalid.
          // Never persistently disable accounts from this read path: doing so
          // would destroy a healthy pool merely because one Runtime launch
          // omitted ACCOUNT_ENCRYPTION_KEY.
          credentialFailure = true;
          continue;
        }
        // An exclusive lease reserves every slot on the selected account. This
        // keeps Studio upload/token refresh isolated while leaving every other
        // account in the pool available for normal generation requests.
        const reservedSlots = exclusive ? account.maxConcurrent : 1;
        this.inflight.set(account.id, (this.inflight.get(account.id) || 0) + reservedSlots);
        account.lastUsedAt = nowIso();
        account.updatedAt = account.lastUsedAt;
        let released = false;
        return {
          account,
          cookie,
          release: async (error?: unknown) => {
            if (released) return;
            released = true;
            this.inflight.set(
              account.id,
              Math.max(0, (this.inflight.get(account.id) || reservedSlots) - reservedSlots),
            );
            this.wakeQueue(
              this.affinityWaiters,
              account.id,
              () => this.accountCanLease(account),
            );
            if (error) {
              if (shouldPenalizeAccount(error)) this.recordFailure(account, error);
              else account.updatedAt = nowIso();
            } else this.recordSuccess(account);
            await this.persist();
          },
        };
      }
    }
    await this.persist();
    if (credentialFailure) {
      throw new AccountPoolCredentialsUnavailableError(tier);
    }
    return null;
  }

  private recordSuccess(account: StoredAccount) {
    account.health = Math.min(1, account.health + 0.08);
    account.failures = Math.max(0, account.failures - 1);
    account.lastSuccessAt = nowIso();
    account.lastError = null;
    // Force a quota re-sync soon after successful work (generation burns credits).
    account.lastQuotaSync = null;
    if (account.enabled && account.creditsLeft !== 0) account.status = 'active';
    account.updatedAt = account.lastSuccessAt;
  }

  private recordFailure(account: StoredAccount, error: unknown) {
    const details = errorDetails(error);
    const timestamp = nowIso();
    account.failures += 1;
    account.health = Math.max(0.05, account.health - 0.18);
    account.lastFailureAt = timestamp;
    account.lastError = details.message.slice(0, 500);
    const authFailure = details.status === 401 || details.lower.includes('session id') || details.lower.includes('update the suno_cookie');
    const rateFailure = details.status === 429 || details.status === 402 || details.lower.includes('rate limit') || details.lower.includes('quota') || details.lower.includes('credits');
    if (authFailure) {
      account.status = 'expired';
      account.cooldownUntil = null;
    } else if (rateFailure || account.failures >= 3) {
      const minutes = rateFailure ? 30 : 5;
      account.status = 'cooling';
      account.cooldownUntil = new Date(Date.now() + minutes * 60_000).toISOString();
      if (details.status === 402 || details.lower.includes('credits')) account.creditsLeft = 0;
    }
    account.updatedAt = timestamp;
  }

  async execute<T>(tier: AccountTier, operation: (cookie: string, account: AccountView | null) => Promise<T>, maxAttempts = 3) {
    const exclude = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = await this.acquire(tier, exclude);
      if (!lease) break;
      try {
        const result = await operation(lease.cookie, this.view(lease.account));
        await lease.release();
        return result;
      } catch (error) {
        lastError = error;
        exclude.add(lease.account.id);
        await lease.release(error);
        const candidate = error as any;
        const status = Number(candidate?.status || candidate?.response?.status || 0);
        const conclusivelyNotSubmitted = candidate?.submissionState === 'not_submitted';
        const safeAccountFailover = conclusivelyNotSubmitted
          && candidate?.allowAccountFailover === true;
        const accountRejectedBeforeSubmission = status === 401 || status === 402;
        // A POST timeout/5xx may already have created music. Never fail over
        // to another account unless the sidecar proved no submission occurred.
        if (!safeAccountFailover && !accountRejectedBeforeSubmission) throw error;
      }
    }

    const fallbackCookie = process.env.SUNO_COOKIE;
    if (fallbackCookie) return operation(fallbackCookie, null);
    if (lastError) throw lastError;
    if (this.hasTemporarilyBusyAccount(tier, exclude)) {
      throw new AccountPoolCapacityError(tier);
    }
    throw new AccountPoolUnavailableError(tier);
  }

  async executeExclusive<T>(
    tier: AccountTier,
    operation: (cookie: string, account: AccountView | null) => Promise<T>,
  ) {
    const lease = await this.acquire(tier, new Set<string>(), undefined, true);
    if (!lease) {
      if (this.hasTemporarilyBusyAccount(tier, new Set<string>(), true)) {
        throw new AccountPoolCapacityError(tier);
      }
      throw new AccountPoolUnavailableError(tier);
    }
    try {
      const result = await operation(lease.cookie, this.view(lease.account));
      await lease.release();
      return result;
    } catch (error) {
      await lease.release(error);
      throw error;
    }
  }

  async executeForAccount<T>(
    tier: AccountTier,
    accountId: string,
    operation: (cookie: string, account: AccountView) => Promise<T>,
    options: AffinityWaitOptions = {},
  ) {
    const normalized = String(accountId || '').trim();
    if (!normalized) throw new AccountAffinityUnavailableError();
    await this.ensureLoaded();
    this.restoreCooledAccounts();
    const account = this.boundAccount(tier, normalized);
    if (!account || !account.enabled || account.status !== 'active' || account.creditsLeft === 0) {
      throw new AccountAffinityUnavailableError();
    }
    const deadline = Date.now() + this.waitMilliseconds(options.maxWaitMs, 120_000);
    let woken = false;
    while (true) {
      // A queued caller must not be bypassed by a later request when a slot is
      // released.  ``woken`` is granted only by the FIFO head.
      const queue = this.affinityWaiters.get(normalized);
      if (!woken && queue && queue.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AccountAffinityBusyError();
        await this.enqueue(
          this.affinityWaiters,
          normalized,
          remaining,
          options.signal,
          () => new AccountAffinityBusyError(),
        );
        woken = true;
      }
      let lease: PoolLease | null;
      try {
        lease = await this.acquire(tier, new Set<string>(), normalized);
      } catch (error) {
        if (error instanceof AccountPoolCredentialsUnavailableError) {
          throw new AccountAffinityUnavailableError();
        }
        throw error;
      }
      if (lease) {
        try {
          const result = await operation(lease.cookie, this.view(lease.account));
          await lease.release();
          return result;
        } catch (error) {
          await lease.release(error);
          throw error;
        }
      }
      woken = false;
      const refreshed = this.boundAccount(tier, normalized);
      if (!refreshed || !refreshed.enabled || refreshed.status !== 'active' || refreshed.creditsLeft === 0) {
        throw new AccountAffinityUnavailableError();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AccountAffinityBusyError();
      await this.enqueue(
        this.affinityWaiters,
        normalized,
        remaining,
        options.signal,
        () => new AccountAffinityBusyError(),
      );
      woken = true;
    }
  }

  private async acquireLongGate(
    key: string,
    options: AffinityWaitOptions = {},
  ): Promise<() => void> {
    const normalized = String(key || '').trim() || 'default';
    const deadline = Date.now() + this.waitMilliseconds(options.maxWaitMs, 300_000);
    let woken = false;
    while (true) {
      if (!woken && this.longActive.has(normalized)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AccountAffinityBusyError();
        await this.enqueue(
          this.longWaiters,
          normalized,
          remaining,
          options.signal,
          () => new AccountAffinityBusyError(),
        );
        woken = true;
      }
      if (!this.longActive.has(normalized)) {
        this.longActive.add(normalized);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.longActive.delete(normalized);
          this.wakeQueue(this.longWaiters, normalized, () => !this.longActive.has(normalized));
        };
      }
      woken = false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AccountAffinityBusyError();
      await this.enqueue(
        this.longWaiters,
        normalized,
        remaining,
        options.signal,
        () => new AccountAffinityBusyError(),
      );
      woken = true;
    }
  }

  async executeLongForAccount<T>(
    tier: AccountTier,
    accountId: string,
    operation: (cookie: string, account: AccountView) => Promise<T>,
    options: AffinityWaitOptions = {},
  ) {
    const normalized = String(accountId || '').trim();
    if (!normalized) throw new AccountAffinityUnavailableError();
    const totalWaitMs = this.waitMilliseconds(options.maxWaitMs, 300_000);
    const startedAt = Date.now();
    // The long-operation latch is acquired before the account lease.  Waiting
    // for another render therefore never consumes an account concurrency slot.
    const release = await this.acquireLongGate(
      `account:${normalized}`,
      { ...options, maxWaitMs: totalWaitMs },
    );
    try {
      const remaining = Math.max(1, totalWaitMs - (Date.now() - startedAt));
      return await this.executeForAccount(
        tier,
        normalized,
        operation,
        { ...options, maxWaitMs: remaining },
      );
    } finally {
      release();
    }
  }

  async executeLong<T>(
    key: string,
    operation: () => Promise<T>,
    options: AffinityWaitOptions = {},
  ) {
    const release = await this.acquireLongGate(`operation:${key}`, options);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private applyQuota(account: StoredAccount, quota: QuotaSnapshot) {
    account.creditsLeft = Number.isFinite(Number(quota.credits_left)) ? Number(quota.credits_left) : null;
    account.period = typeof quota.period === 'string' ? quota.period : null;
    account.monthlyLimit = Number.isFinite(Number(quota.monthly_limit)) ? Number(quota.monthly_limit) : null;
    account.monthlyUsage = Number.isFinite(Number(quota.monthly_usage)) ? Number(quota.monthly_usage) : null;
    account.lastQuotaSync = nowIso();
    account.lastError = null;
    account.failures = Math.max(0, account.failures - 1);
    account.health = Math.min(1, account.health + 0.05);
    account.status = account.enabled ? (account.creditsLeft === 0 ? 'cooling' : 'active') : 'disabled';
    account.cooldownUntil = account.creditsLeft === 0 ? account.cooldownUntil : null;
    account.updatedAt = account.lastQuotaSync;
  }

  async refreshOne(id: string, fetchQuota: (cookie: string) => Promise<QuotaSnapshot>) {
    await this.ensureLoaded();
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new Error('Account not found.');
    let cookie: string;
    try {
      cookie = decrypt(account.cookie);
    } catch {
      throw new AccountPoolCredentialsUnavailableError(account.tier);
    }
    try {
      const quota = await fetchQuota(cookie);
      this.applyQuota(account, quota);
      await this.persist();
      return this.view(account);
    } catch (error) {
      this.recordFailure(account, error);
      await this.persist();
      throw error;
    }
  }

  async refreshAll(fetchQuota: (cookie: string) => Promise<QuotaSnapshot>, staleOnly = false) {
    await this.ensureLoaded();
    const interval = Math.max(60, Number(process.env.ACCOUNT_QUOTA_SYNC_INTERVAL_SEC) || 300) * 1000;
    const now = Date.now();
    const targets = this.accounts.filter((account) => (
      account.enabled
      && (this.inflight.get(account.id) || 0) === 0
      && (!staleOnly || !account.lastQuotaSync || now - Date.parse(account.lastQuotaSync) >= interval)
    ));
    const cookies = new Map<string, string>();
    for (const account of targets) {
      try {
        cookies.set(account.id, decrypt(account.cookie));
      } catch {
        throw new AccountPoolCredentialsUnavailableError(account.tier);
      }
    }
    let refreshed = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index += 2) {
      await Promise.all(targets.slice(index, index + 2).map(async (account) => {
        try {
          const quota = await fetchQuota(cookies.get(account.id)!);
          this.applyQuota(account, quota);
          refreshed += 1;
        } catch (error) {
          this.recordFailure(account, error);
          failed += 1;
        }
      }));
    }
    await this.persist();
    return { refreshed, failed };
  }

  async refreshStale(fetchQuota: (cookie: string) => Promise<QuotaSnapshot>) {
    const intervalMs = Math.max(60, Number(process.env.ACCOUNT_QUOTA_SYNC_INTERVAL_SEC) || 300) * 1000;
    if (Date.now() - this.lastRefreshSweep < intervalMs) return { refreshed: 0, failed: 0 };
    if (this.refreshPromise) return this.refreshPromise;
    this.lastRefreshSweep = Date.now();
    this.refreshPromise = this.refreshAll(fetchQuota, true).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }
}

const globalForAccountPool = global as unknown as { accountPool?: AccountPool };

export function getAccountPool() {
  if (!globalForAccountPool.accountPool) globalForAccountPool.accountPool = new AccountPool();
  return globalForAccountPool.accountPool;
}
