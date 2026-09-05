import { NextRequest, NextResponse } from 'next/server';
import {
  getApiKeySettingsSync,
  loadApiKeySettings,
} from '@/lib/api-key-settings';
import { corsHeaders } from '@/lib/utils';

function extractBearer(request: NextRequest): string {
  const auth = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const apiKeyHeader = request.headers.get('x-api-key') || request.headers.get('api-key') || '';
  return apiKeyHeader.trim();
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * Enforce API key for public OpenAI-compatible endpoints when enabled.
 * Accepts Authorization: Bearer <key> or x-api-key / api-key headers.
 */
export async function requireApiKey(request: NextRequest): Promise<NextResponse | null> {
  await loadApiKeySettings(true);
  const settings = getApiKeySettingsSync();
  if (!settings.enabled || !settings.apiKey) return null;

  const provided = extractBearer(request);
  if (!provided || !safeEqual(provided, settings.apiKey)) {
    return NextResponse.json(
      {
        error: {
          message: 'Invalid API key. Provide Authorization: Bearer <key>.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401, headers: corsHeaders },
    );
  }
  return null;
}
