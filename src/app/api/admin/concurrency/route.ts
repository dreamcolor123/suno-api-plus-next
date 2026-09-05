import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import {
  ConcurrencySettingsValidationError,
  getConcurrencySnapshot,
  saveConcurrencySettings,
} from '@/lib/concurrency-settings';

export const dynamic = 'force-dynamic';

const responseHeaders = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json(await getConcurrencySnapshot(true), { headers: responseHeaders });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Unable to load concurrency settings.' },
      { status: 500, headers: responseHeaders },
    );
  }
}

export async function PUT(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      throw new ConcurrencySettingsValidationError('请求体必须是 JSON 对象。');
    }
    await saveConcurrencySettings(body);
    return NextResponse.json(
      {
        ...(await getConcurrencySnapshot()),
        message: '并发限制已保存并立即生效。',
      },
      { headers: responseHeaders },
    );
  } catch (error: any) {
    const status = error instanceof ConcurrencySettingsValidationError || error instanceof SyntaxError
      ? 400
      : 500;
    return NextResponse.json(
      { error: error?.message || 'Unable to save concurrency settings.' },
      { status, headers: responseHeaders },
    );
  }
}
