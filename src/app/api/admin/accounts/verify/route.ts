import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
    if (!cookie) {
      return NextResponse.json({ error: 'Cookie is required.' }, { status: 400 });
    }
    if (!cookie.includes('__client')) {
      return NextResponse.json({ error: 'The Suno cookie must contain __client.' }, { status: 400 });
    }

    const quota = await (await sunoApi(cookie)).get_credits();
    return NextResponse.json({
      ok: true,
      message: 'Cookie verified successfully.',
      quota,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Cookie verification failed.' },
      { status: 400 },
    );
  }
}
