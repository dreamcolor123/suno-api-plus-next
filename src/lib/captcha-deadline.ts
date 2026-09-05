// Keep the complete challenge -> provider -> Suno submission boundary below
// the Python Runtime's 300-second request timeout, including cleanup time.
export const DEFAULT_CAPTCHA_ACQUISITION_TIMEOUT_MS = 220_000;
export const MAX_CAPTCHA_ACQUISITION_TIMEOUT_MS = 225_000;
const MIN_CAPTCHA_ACQUISITION_TIMEOUT_MS = 10_000;

export class CaptchaAcquisitionDeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('CAPTCHA acquisition exceeded its pre-submission deadline.');
    this.name = 'CaptchaAcquisitionDeadlineError';
    this.timeoutMs = timeoutMs;
  }
}

export function captchaAcquisitionTimeoutMs(
  raw: string | number | undefined = process.env.CAPTCHA_ACQUISITION_TIMEOUT_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CAPTCHA_ACQUISITION_TIMEOUT_MS;
  }
  return Math.min(
    MAX_CAPTCHA_ACQUISITION_TIMEOUT_MS,
    Math.max(MIN_CAPTCHA_ACQUISITION_TIMEOUT_MS, Math.trunc(parsed)),
  );
}

export async function runWithCaptchaAcquisitionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = captchaAcquisitionTimeoutMs(),
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CaptchaAcquisitionDeadlineError(timeoutMs));
    }, timeoutMs);
  });
  const running = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
