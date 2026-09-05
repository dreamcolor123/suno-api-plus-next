import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE_NAME, adminConfigured, isAdminRequest, sessionValue } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return NextResponse.json({ configured: adminConfigured(), authenticated: isAdminRequest(request) });
}

export async function POST(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD is not configured on the server.' }, { status: 503 });
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const submitted = typeof body.password === 'string' ? body.password : '';
  const expected = Buffer.from(password);
  const actual = Buffer.from(submitted);
  const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!valid) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: sessionValue(password),
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' && request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set({ name: ADMIN_COOKIE_NAME, value: '', path: '/', maxAge: 0 });
  return response;
}
