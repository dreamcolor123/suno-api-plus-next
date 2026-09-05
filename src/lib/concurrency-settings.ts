import path from 'node:path';
import { promises as fs } from 'node:fs';

export type ConcurrencySettings = {
  maxConcurrentRequests: number;
  updatedAt?: string;
};

type ConcurrencyRuntime = {
  activeRequests: number;
  cached: ConcurrencySettings | null;
  loaded: boolean;
  loading?: Promise<ConcurrencySettings>;
  writeQueue: Promise<void>;
};

export const DEFAULT_CONCURRENCY_SETTINGS: ConcurrencySettings = {
  maxConcurrentRequests: 4,
};

const MAX_CONCURRENT_REQUESTS = 100;
const globalRuntime = globalThis as typeof globalThis & {
  __sunoConcurrencyRuntime?: ConcurrencyRuntime;
};

const runtime = globalRuntime.__sunoConcurrencyRuntime ?? {
  activeRequests: 0,
  cached: null,
  loaded: false,
  writeQueue: Promise.resolve(),
};

globalRuntime.__sunoConcurrencyRuntime = runtime;

function settingsPath() {
  const dataPath = process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json');
  return path.join(path.dirname(dataPath), 'concurrency-settings.json');
}

function normalizeLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENT_REQUESTS) {
    throw new ConcurrencySettingsValidationError(
      `最大并发必须是 1-${MAX_CONCURRENT_REQUESTS} 之间的整数。`,
    );
  }
  return limit;
}

function settingsFromFile(input: unknown): ConcurrencySettings {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const settings: ConcurrencySettings = { ...DEFAULT_CONCURRENCY_SETTINGS };
  try {
    settings.maxConcurrentRequests = normalizeLimit(source.maxConcurrentRequests);
  } catch {
    // Invalid persisted values fall back to the safe default.
  }
  if (typeof source.updatedAt === 'string') settings.updatedAt = source.updatedAt;
  return settings;
}

export class ConcurrencySettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencySettingsValidationError';
  }
}

export class GenerationConcurrencyLimitError extends Error {
  readonly status = 429;
  readonly code = 'concurrency_limit_exceeded';
  readonly retryAfterSeconds = 5;
  readonly limit: number;
  readonly activeRequests: number;
  readonly response: {
    status: number;
    statusText: string;
    data: {
      detail: string;
      code: string;
      limit: number;
      active_requests: number;
      retry_after: number;
    };
  };

  constructor(limit: number, activeRequests: number) {
    const message = 'Global generation concurrency limit exceeded.';
    super(message);
    this.name = 'GenerationConcurrencyLimitError';
    this.limit = limit;
    this.activeRequests = activeRequests;
    this.response = {
      status: this.status,
      statusText: 'Too Many Requests',
      data: {
        detail: message,
        code: this.code,
        limit,
        active_requests: activeRequests,
        retry_after: this.retryAfterSeconds,
      },
    };
  }
}

export async function loadConcurrencySettings(force = false): Promise<ConcurrencySettings> {
  if (runtime.loaded && runtime.cached && !force) return runtime.cached;
  if (runtime.loading) return runtime.loading;

  runtime.loading = (async () => {
    let settings = { ...DEFAULT_CONCURRENCY_SETTINGS };
    try {
      const raw = await fs.readFile(settingsPath(), 'utf8');
      settings = settingsFromFile(JSON.parse(raw));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('Unable to load concurrency settings:', error);
    }
    runtime.cached = settings;
    runtime.loaded = true;
    return settings;
  })();

  try {
    return await runtime.loading;
  } finally {
    runtime.loading = undefined;
  }
}

export async function saveConcurrencySettings(
  input: Partial<ConcurrencySettings>,
): Promise<ConcurrencySettings> {
  const current = await loadConcurrencySettings(true);
  const next: ConcurrencySettings = {
    ...current,
    maxConcurrentRequests: normalizeLimit(input.maxConcurrentRequests),
    updatedAt: new Date().toISOString(),
  };
  const file = settingsPath();

  runtime.writeQueue = runtime.writeQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  });
  await runtime.writeQueue;
  runtime.cached = next;
  runtime.loaded = true;
  return next;
}

export async function getConcurrencySnapshot(force = false) {
  const settings = await loadConcurrencySettings(force);
  return {
    settings,
    activeRequests: runtime.activeRequests,
    availableSlots: Math.max(0, settings.maxConcurrentRequests - runtime.activeRequests),
  };
}

export async function withGenerationConcurrency<T>(operation: () => Promise<T>): Promise<T> {
  const settings = await loadConcurrencySettings();
  if (runtime.activeRequests >= settings.maxConcurrentRequests) {
    throw new GenerationConcurrencyLimitError(
      settings.maxConcurrentRequests,
      runtime.activeRequests,
    );
  }

  runtime.activeRequests += 1;
  try {
    return await operation();
  } finally {
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
  }
}
