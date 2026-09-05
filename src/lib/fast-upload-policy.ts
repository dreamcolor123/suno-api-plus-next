import crypto from 'node:crypto';

export const DIRECT_UPLOAD_MAX_SECONDS = 30;

export type UploadMethod = 'direct' | 'studio_fast';

export function uploadMethodForDuration(durationSeconds: number): UploadMethod {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError('durationSeconds must be a finite positive number.');
  }
  return durationSeconds <= DIRECT_UPLOAD_MAX_SECONDS ? 'direct' : 'studio_fast';
}

function stableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function fastUploadFingerprint(
  contentSha256: string,
  metadata: Record<string, unknown>,
): string {
  const normalized = Object.fromEntries(
    Object.keys(metadata)
      .sort()
      .map((key) => [key, stableText(metadata[key])]),
  );
  return crypto
    .createHash('sha256')
    .update('suno-fast-upload-v1\0')
    .update(contentSha256)
    .update('\0')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

export function idempotencyStorageId(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
