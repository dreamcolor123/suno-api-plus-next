import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountAffinity } from '@/lib/account-affinity';
import { AudioDurationError, probeAudioDuration } from '@/lib/audio-duration';
import { accountTier } from '@/lib/account-pool';
import { compatRouteError } from '@/lib/compat-route-error';
import { executeStudioFastUpload, FastUploadError } from '@/lib/fast-upload';
import { uploadMethodForDuration } from '@/lib/fast-upload-policy';
import { runSunoRequest } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const maxDuration = 1800;
export const dynamic = 'force-dynamic';

function getText(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getBoolean(form: FormData, key: string): boolean {
  const value = getText(form, key);
  if (!value) return false;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function normalizeTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Uploaded demo';
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const audioFile = form.get('audio_file') || form.get('file');
    if (!audioFile || typeof audioFile === 'string') {
      return new NextResponse(JSON.stringify({ error: 'audio_file is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const filename = audioFile.name || 'uploaded-demo.mp3';
    const title = getText(form, 'title') || normalizeTitle(filename);
    const prompt = getText(form, 'prompt') || getText(form, 'description');
    const imageUrl = getText(form, 'image_url');
    const deferMetadata = getBoolean(form, 'defer_metadata');
    const requestedUploadMethod = getText(form, 'upload_method');
    if (requestedUploadMethod && !['direct', 'studio_fast'].includes(requestedUploadMethod)) {
      return NextResponse.json({
        error: {
          message: 'upload_method must be direct or studio_fast.',
          type: 'invalid_request_error',
          code: 'invalid_upload_method',
          submission_state: 'not_submitted',
        },
      }, { status: 422, headers: corsHeaders });
    }
    const arrayBuffer = await audioFile.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    const requestCookie = (await cookies()).toString();
    const tier = accountTier(getText(form, 'pool') || req.headers.get('x-suno-pool'));
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suno-upload-probe-'));
    const extension = path.extname(path.basename(filename)).toLowerCase();
    const probePath = path.join(probeDir, `audio${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'}`);
    let durationSeconds: number;
    try {
      await fs.writeFile(probePath, audio, { mode: 0o600 });
      durationSeconds = await probeAudioDuration(probePath, req.signal);
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true, maxRetries: 3 });
    }

    const automaticUploadMethod = uploadMethodForDuration(durationSeconds);
    if (requestedUploadMethod === 'direct' && automaticUploadMethod === 'studio_fast') {
      return NextResponse.json({
        error: {
          message: 'Direct upload is unavailable for audio longer than 30 seconds.',
          type: 'invalid_request_error',
          code: 'direct_upload_duration_exceeded',
          submission_state: 'not_submitted',
        },
      }, { status: 422, headers: corsHeaders });
    }
    const uploadMethod = requestedUploadMethod || automaticUploadMethod;
    if (uploadMethod === 'studio_fast') {
      const result = await executeStudioFastUpload({
        audio,
        filename,
        metadata: { title, prompt, imageUrl, deferMetadata },
        durationSeconds,
        idempotencyKey: req.headers.get('idempotency-key') || undefined,
        tier,
        signal: req.signal,
      });
      return new NextResponse(JSON.stringify(result), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Suno-Account-Affinity': result.account_affinity,
          ...corsHeaders,
        },
      });
    }

    const result = await runSunoRequest(requestCookie, tier, async (api, account) => {
      const uploaded = await api.uploadAudio(audio, filename, {
        extension: getText(form, 'extension'),
        upload_type: getText(form, 'upload_type') || 'file_upload',
      });
      const initialized = await api.initializeUploadedClip(uploaded.id, {
        title,
        prompt,
        image_url: imageUrl,
        user_reviewed_tags: true,
      });
      return {
        upload_method: 'direct' as const,
        upload_id: uploaded.id,
        clip_id: initialized.clip_id,
        duration_seconds: durationSeconds,
        portable_clip: false as const,
        title: initialized.title || title,
        image_url: initialized.image_url,
        has_vocal: initialized.has_vocal,
        status: initialized.status,
        inferred_description: initialized.inferred_description,
        copyright_muted: initialized.copyright_muted,
        account_affinity: account ? createAccountAffinity(account.id) : undefined,
      };
    }, 1);

    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...(result.account_affinity
          ? { 'X-Suno-Account-Affinity': result.account_affinity }
          : {}),
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    if (error instanceof AudioDurationError) {
      return NextResponse.json({
        error: {
          message: error.message,
          type: 'invalid_request_error',
          code: error.code,
          submission_state: error.submissionState,
        },
      }, { status: error.status, headers: corsHeaders });
    }
    if (error instanceof FastUploadError) {
      return NextResponse.json({
        error: {
          message: error.message,
          type: error.status === 409 ? 'conflict_error' : 'fast_upload_error',
          code: error.code,
          submission_state: error.submissionState,
          ...(error.studioProjectId ? { studio_project_id: error.studioProjectId } : {}),
          ...(error.retryAfterSeconds ? { retry_after: error.retryAfterSeconds } : {}),
        },
      }, {
        status: error.status,
        headers: {
          ...corsHeaders,
          ...(error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {}),
        },
      });
    }
    return compatRouteError('upload_audio', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
