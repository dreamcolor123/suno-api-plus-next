import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export async function POST() {
  return Response.json(
    {
      error: {
        code: 'advanced_stems_legacy_download_disabled',
        message: 'Legacy Advanced Stem WAV conversion is disabled; use Studio clip download.',
      },
    },
    { status: 410, headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
