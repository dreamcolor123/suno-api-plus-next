export type ClipDownloadStatus = {
  clip_id: string;
  format: 'mp3' | 'm4a';
  status: 'ready' | 'processing' | 'error';
  download_url?: string;
  retry_after_seconds?: number;
  message?: string;
};

export type StudioClipDownloadStatus = {
  clip_id: string;
  format: 'wav' | 'mp3' | 'm4a';
  status: 'ready' | 'processing' | 'error';
  download_url?: string;
  retry_after_seconds?: number;
  message?: string;
};

/** Normalize Suno's independently prepared audio-download state machine. */
export function normalizeClipDownloadResponse(
  clipId: string,
  format: 'mp3' | 'm4a',
  value: unknown,
): ClipDownloadStatus {
  const payload = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const providerStatus = String(payload.status || '').trim().toLowerCase();
  const downloadUrl = String(
    payload.download_url || payload.downloadUrl || '',
  ).trim();
  if (
    (providerStatus === 'ready' || (!providerStatus && downloadUrl))
    && /^https:\/\//i.test(downloadUrl)
  ) {
    return {
      clip_id: clipId,
      format,
      status: 'ready',
      download_url: downloadUrl,
    };
  }
  if (
    ['processing', 'pending', 'queued', 'preparing'].includes(providerStatus)
    || payload.ok === true
  ) {
    const retryAfter = Number(
      payload.retry_after_seconds || payload.retry_after || 2,
    );
    return {
      clip_id: clipId,
      format,
      status: 'processing',
      retry_after_seconds: Math.max(
        1,
        Math.min(30, Number.isFinite(retryAfter) ? Math.ceil(retryAfter) : 2),
      ),
    };
  }
  return {
    clip_id: clipId,
    format,
    status: 'error',
    message: String(
      payload.message || payload.detail || 'Suno could not prepare this audio download.',
    ).slice(0, 512),
  };
}

/** Normalize the Studio single-clip export state machine.
 *
 * Studio accepts WAV in addition to the feed download formats.  Keep this
 * response separate from the paid/feed download contract so callers cannot
 * accidentally fall back to `/api/download/clip`.
 */
export function normalizeStudioClipDownloadResponse(
  clipId: string,
  format: 'wav' | 'mp3' | 'm4a',
  value: unknown,
): StudioClipDownloadStatus {
  const payload = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const providerStatus = String(payload.status || '').trim().toLowerCase();
  const downloadUrl = String(
    payload.download_url || payload.downloadUrl || '',
  ).trim();
  if (
    (providerStatus === 'ready' || (!providerStatus && downloadUrl))
    && /^https:\/\//i.test(downloadUrl)
  ) {
    return {
      clip_id: clipId,
      format,
      status: 'ready',
      download_url: downloadUrl,
    };
  }
  if (
    ['processing', 'pending', 'queued', 'preparing'].includes(providerStatus)
    || payload.ok === true
  ) {
    const retryAfter = Number(
      payload.retry_after_seconds || payload.retry_after || 2,
    );
    return {
      clip_id: clipId,
      format,
      status: 'processing',
      retry_after_seconds: Math.max(
        1,
        Math.min(30, Number.isFinite(retryAfter) ? Math.ceil(retryAfter) : 2),
      ),
    };
  }
  return {
    clip_id: clipId,
    format,
    status: 'error',
    message: String(
      payload.message || payload.detail || 'Suno Studio could not prepare this audio download.',
    ).slice(0, 512),
  };
}
