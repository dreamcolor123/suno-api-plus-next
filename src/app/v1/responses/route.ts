import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { withSunoAccount } from '@/lib/SunoApi';
import { accountTier } from '@/lib/account-pool';
import { audioToText, promptFromResponseInput, tokenEstimate } from '@/lib/openai-compatible';
import { resolveOpenAIModel } from '@/lib/suno-models';
import { corsHeaders } from '@/lib/utils';
import { requireApiKey } from '@/lib/api-auth';
import { withGenerationConcurrency } from '@/lib/concurrency-settings';
import { concurrencyLimitResponse } from '@/lib/concurrency-response';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorized = await requireApiKey(request);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }, { status: 400, headers: corsHeaders });
  const prompt = promptFromResponseInput(body.input);
  if (!prompt) return NextResponse.json({ error: { message: 'The input field is required.', type: 'invalid_request_error' } }, { status: 400, headers: corsHeaders });

  const model = resolveOpenAIModel(body.model);
  try {
    const audios = await withGenerationConcurrency(() => withSunoAccount(
      accountTier(body.pool || request.headers.get('x-suno-pool')),
      (api) => api.generate(prompt, true, model, true),
    ));
    const outputText = audioToText(audios);
    const promptTokens = tokenEstimate(prompt);
    const completionTokens = tokenEstimate(outputText);
    const responseId = `resp_${randomUUID()}`;
    return NextResponse.json({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [{
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: outputText, annotations: [] }],
      }],
      output_text: outputText,
      usage: { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error('OpenAI response error:', error);
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return NextResponse.json({ error: { message: error?.response?.data?.detail || error?.message || 'Music generation failed.', type: 'api_error' } }, { status: error?.response?.status || 502, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
