import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export async function POST() {
  return Response.json(
    {
      error: {
        code: 'advanced_stems_legacy_download_disabled',
        message: 'Legacy multitrack rendering is disabled; download Studio WAV clips and package locally.',
      },
    },
    { status: 410, headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
