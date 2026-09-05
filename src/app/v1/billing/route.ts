import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { getBillingSnapshot } from '@/lib/billing-settings';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;

  try {
    const { settings, summary } = await getBillingSnapshot(true);
    return NextResponse.json(
      { object: 'billing_settings', settings, summary },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: err?.message || 'Failed to load billing settings.',
          type: 'api_error',
        },
      },
      { status: 500, headers: corsHeaders },
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
