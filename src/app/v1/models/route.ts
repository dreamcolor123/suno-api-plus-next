import { NextRequest, NextResponse } from 'next/server';
import { listOpenAIModelRecords } from '@/lib/suno-models';
import { corsHeaders } from '@/lib/utils';
import { requireApiKey } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;
  const created = Math.floor(Date.now() / 1000);
  return NextResponse.json({
    object: 'list',
    data: listOpenAIModelRecords(created),
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
