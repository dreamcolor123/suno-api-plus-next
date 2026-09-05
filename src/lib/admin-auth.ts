import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

export const ADMIN_COOKIE_NAME = 'suno_admin_session';

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function matches(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function adminConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function isAdminRequest(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  const session = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
  return Boolean(password && session && matches(digest(password), session));
}

export function requireAdmin(request: NextRequest) {
  if (!adminConfigured()) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD is not configured on the server.' }, { status: 503 });
  }

  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Admin authentication required.' }, { status: 401 });
  }

  return null;
}

export function sessionValue(password: string) {
  return digest(password);
}
