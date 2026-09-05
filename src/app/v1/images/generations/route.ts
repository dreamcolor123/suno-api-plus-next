import { NextRequest, NextResponse } from 'next/server';
import { unsupportedResponse } from '@/lib/openai-compatible';
import { corsHeaders } from '@/lib/utils';
import { requireApiKey } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json(unsupportedResponse('image'), { status: 501, headers: corsHeaders });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
