import { NextRequest, NextResponse } from 'next/server';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { AccountAffinityError, readAccountAffinity } from '@/lib/account-affinity';
import { runSunoRequestWithAffinity } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type FieldStatus = {
  status: 'updated' | 'failed' | 'skipped';
  code: string | null;
  retryable: boolean;
  error?: string;
};

type MetadataBody = {
  lyrics?: unknown;
  description?: unknown;
  account_affinity?: unknown;
  pool?: unknown;
};

const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LYRICS_LENGTH = 250_000;
const MAX_DESCRIPTION_LENGTH = 10_000;

function jsonError(message: string, status = 400, code = 'invalid_request') {
  return NextResponse.json(
    {
      error: {
        message,
        type: 'invalid_request_error',
        code,
        submission_state: 'not_submitted',
      },
    },
    { status, headers: corsHeaders },
  );
}

function retryableError(error: any): boolean {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = Number(error?.response?.status || error?.status || 0);
  const code = safeProviderCode(error).toLowerCase();
  if (code === 'rate_limited' || code.includes('timeout')) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500 || !status;
}

function safeProviderCode(error: any): string {
  const data = error?.response?.data;
  const candidates = [
    data?.error_type,
    data?.error?.code,
    data?.error?.type,
    data?.detail?.error_type,
    data?.detail?.code,
    error?.code,
  ];
  for (const candidate of candidates) {
    const code = String(candidate || '').trim();
    if (/^(ECONN|ETIMEDOUT|EAI_AGAIN)/i.test(code)) return 'network_error';
    if (/^[A-Za-z0-9_.-]{1,128}$/.test(code) && !code.startsWith('ERR_')) {
      return code;
    }
  }
  return '';
}

function publicErrorCode(error: any): string {
  const providerCode = safeProviderCode(error);
  if (providerCode) return providerCode;
  const status = Number(error?.response?.status || error?.status || 0);
  if (status === 401 || status === 403) return 'suno_auth_failed';
  if (status === 404) return 'clip_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'suno_upstream_error';
  if (!status) return 'network_error';
  return 'metadata_update_failed';
}

function safeFieldError(error: any): string {
  const code = publicErrorCode(error);
  // Do not expose axios request dumps: they may contain cookies, affinity
  // tokens, or provider response headers.  The stable code is sufficient for
  // the retry UI and diagnostics.
  return code;
}

function isPresent(body: MetadataBody, field: keyof Pick<MetadataBody, 'lyrics' | 'description'>): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function validateText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  if (value.length > maxLength) throw new Error(`${field} is too long.`);
  return field === 'lyrics' ? value : value.trim();
}

async function updateField(
  operation: () => Promise<unknown>,
): Promise<FieldStatus> {
  try {
    await operation();
    return { status: 'updated', code: null, retryable: false };
  } catch (error: any) {
    const code = publicErrorCode(error);
    return {
      status: 'failed',
      code,
      retryable: retryableError(error),
      error: safeFieldError(error),
    };
  }
}

export async function POST(
  req: NextRequest,
  context: { params: { clip_id: string } },
) {
  const clipId = String(context?.params?.clip_id || '').trim();
  if (!CLIP_ID_PATTERN.test(clipId)) {
    return jsonError('clip_id is invalid.', 422, 'invalid_clip_id');
  }

  let body: MetadataBody;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonError('Request body must be a JSON object.');
    }
    body = parsed as MetadataBody;
  } catch {
    return jsonError('Request body must be valid JSON.');
  }

  const hasLyrics = isPresent(body, 'lyrics');
  const hasDescription = isPresent(body, 'description');
  if (!hasLyrics && !hasDescription) {
    return jsonError('At least one of lyrics or description is required.', 422, 'metadata_field_required');
  }

  let lyrics: string | undefined;
  let description: string | undefined;
  try {
    if (hasLyrics) lyrics = validateText(body.lyrics, 'lyrics', MAX_LYRICS_LENGTH);
    if (hasDescription) description = validateText(body.description, 'description', MAX_DESCRIPTION_LENGTH);
  } catch (error: any) {
    return jsonError(String(error?.message || 'Invalid metadata field.'), 422, 'invalid_metadata');
  }

  const affinityInput = Object.prototype.hasOwnProperty.call(body, 'account_affinity')
    ? body.account_affinity
    : req.headers.get('x-suno-account-affinity');
  if (affinityInput === undefined || affinityInput === null || affinityInput === '') {
    return jsonError(
      'account_affinity is required for clip metadata updates.',
      422,
      'account_affinity_required',
    );
  }

  let accountId: string;
  try {
    const resolvedAccountId = readAccountAffinity(affinityInput);
    if (!resolvedAccountId) {
      return jsonError(
        'account_affinity is required for clip metadata updates.',
        422,
        'account_affinity_required',
      );
    }
    accountId = resolvedAccountId;
  } catch (error) {
    if (error instanceof AccountAffinityError) {
      return jsonError(
        'account_affinity is invalid or expired.',
        422,
        'invalid_account_affinity',
      );
    }
    return compatRouteError('clip_metadata', error, corsHeaders);
  }

  try {
    const tier = accountTier(String(
      body.pool
      || req.headers.get('x-suno-pool')
      || '',
    ));
    const result = await runSunoRequestWithAffinity(
      undefined,
      tier,
      accountId,
      async (api) => {
        const fields: Record<string, FieldStatus> = {};
        if (hasLyrics) {
          fields.lyrics = await updateField(() => api.setUploadedClipMetadata(clipId, { lyrics }));
        }
        if (hasDescription) {
          fields.description = await updateField(async () => {
            const clip: any = await api.getClip(clipId);
            const clipType = String(clip?.metadata?.type || clip?.type || '').trim().toLowerCase();
            // Suno stores a raw upload's editable description under
            // ``user_corrected_description``.  Studio fast upload returns a
            // rendered/context-window clip instead, whose Song Details style
            // field is ``display_tags``.  Calling the raw-upload endpoint for
            // that clip deterministically returns HTTP 400.
            if (clipType === 'upload') {
              return api.setUploadedClipAudioDescription(clipId, description || '');
            }
            return api.setUploadedClipDisplayTags(clipId, description || '');
          });
        }
        const statuses = Object.values(fields).map((field) => field.status);
        const status = statuses.length > 0 && statuses.every((value) => value === 'updated')
          ? 'completed'
          : statuses.some((value) => value === 'updated')
            ? 'partial'
            : 'failed';
        return { clip_id: clipId, status, fields };
      },
    );
    return NextResponse.json(result, { status: 200, headers: corsHeaders });
  } catch (error: any) {
    return compatRouteError('clip_metadata', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
