import { NextRequest, NextResponse } from 'next/server';
import { getSunoModelDefinition, toOpenAIModelRecord } from '@/lib/suno-models';
import { corsHeaders } from '@/lib/utils';
import { requireApiKey } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { model: string } },
) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;

  const definition = getSunoModelDefinition(params.model);
  if (!definition) {
    return NextResponse.json({
      error: {
        message: `The model '${params.model}' does not exist.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    }, { status: 404, headers: corsHeaders });
  }

  return NextResponse.json(
    toOpenAIModelRecord(definition, Math.floor(Date.now() / 1000)),
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
