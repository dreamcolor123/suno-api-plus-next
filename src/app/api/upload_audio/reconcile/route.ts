import { NextRequest, NextResponse } from 'next/server';

import {
  FastUploadError,
  reconcileStudioFastUpload,
} from '@/lib/fast-upload';
import { compatRouteError } from '@/lib/compat-route-error';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Read-only reconciliation for a Studio fast-upload idempotency record.
 *
 * This route never starts a worker and never calls Suno.  It exists so the
 * Runtime can distinguish a completed local operation from a project whose
 * final Clip is still unknown before asking the user to authorize a replay.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const idempotencyKey = String(
      body?.idempotency_key || req.headers.get('idempotency-key') || '',
    ).trim();
    if (!idempotencyKey) {
      throw new FastUploadError({
        message: 'Idempotency-Key is required.',
        code: 'invalid_idempotency_key',
        status: 400,
        submissionState: 'not_submitted',
      });
    }
    const result = await reconcileStudioFastUpload(idempotencyKey);
    return NextResponse.json(result, { status: 200, headers: corsHeaders });
  } catch (error: any) {
    if (error instanceof FastUploadError) {
      return NextResponse.json(
        {
          error: {
            message: error.message,
            type: 'fast_upload_error',
            code: error.code,
            submission_state: error.submissionState,
            ...(error.retryAfterSeconds
              ? { retry_after: error.retryAfterSeconds }
              : {}),
          },
        },
        { status: error.status, headers: corsHeaders },
      );
    }
    return compatRouteError('upload_audio_reconcile', error, corsHeaders);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
