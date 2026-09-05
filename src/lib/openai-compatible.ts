import { AudioInfo } from '@/lib/SunoApi';

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => typeof part === 'string' ? part : part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    const value = content as Record<string, unknown>;
    return String(value.text || value.content || '').trim();
  }
  return '';
}

export function promptFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const userMessages = messages.filter((message: any) => message?.role === 'user');
  const last = userMessages[userMessages.length - 1] as any;
  return textFromContent(last?.content);
}

export function promptFromResponseInput(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (!Array.isArray(input)) return textFromContent(input);
  const text = input
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item?.role && item?.content) return textFromContent(item.content);
      return textFromContent(item);
    })
    .filter(Boolean)
    .join('\n');
  return text.trim();
}

export function audioToText(audios: AudioInfo[]) {
  return audios.map((audio, index) => [
    `Track ${index + 1}: ${audio.title || 'Untitled'}`,
    audio.audio_url ? `Audio: ${audio.audio_url}` : '',
    audio.video_url ? `Video: ${audio.video_url}` : '',
    audio.image_url ? `Cover: ${audio.image_url}` : '',
    audio.lyric ? `Lyrics:\n${audio.lyric}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function tokenEstimate(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function unsupportedResponse(capability: string) {
  return {
    error: {
      message: `The Suno provider does not expose independent ${capability} generation. Use /api/generate for music, or connect a provider that supports ${capability}.`,
      type: 'not_supported_error',
      code: 'provider_capability_not_supported',
    },
  };
}
