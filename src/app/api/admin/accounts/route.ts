import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { getAccountPool } from '@/lib/account-pool';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json(await getAccountPool().list());
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const account = await getAccountPool().add(await request.json());
    try {
      const refreshed = await getAccountPool().refreshOne(account.id, async (cookie) => (
        await sunoApi(cookie)
      ).get_credits());
      return NextResponse.json({ account: refreshed }, { status: 201 });
    } catch (error: any) {
      return NextResponse.json({ account, warning: error?.message || 'Account saved but quota refresh failed.' }, { status: 201 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to add account.' }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: 'Account id is required.' }, { status: 400 });
    return NextResponse.json(await getAccountPool().update(String(body.id), body));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to update account.' }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Account id is required.' }, { status: 400 });
  try {
    await getAccountPool().remove(id);
    return NextResponse.json({ deleted: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to delete account.' }, { status: 404 });
  }
}
