import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { withSunoAccount } from '@/lib/SunoApi';
import { accountTier } from '@/lib/account-pool';
import { audioToText, promptFromMessages, tokenEstimate } from '@/lib/openai-compatible';
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
  const prompt = promptFromMessages(body.messages);
  if (!prompt) return NextResponse.json({ error: { message: 'A user message is required.', type: 'invalid_request_error' } }, { status: 400, headers: corsHeaders });

  const model = resolveOpenAIModel(body.model);
  const requestId = `chatcmpl-${randomUUID()}`;
  try {
    const audios = await withGenerationConcurrency(() => withSunoAccount(accountTier(body.pool || request.headers.get('x-suno-pool')), (api) => api.generate(
      prompt,
      Boolean(body.make_instrumental ?? true),
      model,
      true,
    )));
    const content = audioToText(audios);
    const created = Math.floor(Date.now() / 1000);
    if (body.stream === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }

    const promptTokens = tokenEstimate(prompt);
    const completionTokens = tokenEstimate(content);
    return NextResponse.json({
      id: requestId,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error('OpenAI chat completion error:', error);
    const limited = concurrencyLimitResponse(error, corsHeaders);
    if (limited) return limited;
    return NextResponse.json({ error: { message: error?.response?.data?.detail || error?.message || 'Music generation failed.', type: 'api_error' } }, { status: error?.response?.status || 502, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
