import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { loadBillingSettings } from '@/lib/billing-settings';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  ...corsHeaders,
  'Cache-Control': 'no-store',
};

export async function GET(request: NextRequest) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;

  try {
    const settings = await loadBillingSettings(true);
    const multiplier = settings.rateMultiplier;

    return NextResponse.json(
      {
        object: 'sub2api.key_billing',
        schema_version: 1,
        billing_scope: 'token',
        group_rate_multiplier: multiplier,
        resolved_rate_multiplier: multiplier,
        peak_rate_enabled: false,
        effective_rate_multiplier: multiplier,
        observed_at: new Date().toISOString(),
      },
      { headers: responseHeaders },
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: err?.message || 'Failed to load the upstream billing multiplier.',
          type: 'api_error',
        },
      },
      { status: 500, headers: responseHeaders },
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: responseHeaders });
}
