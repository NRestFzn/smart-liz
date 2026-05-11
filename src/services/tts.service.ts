interface TtsResult {
  audioUrl: string;
}

import logger from '../lib/logger.js';

const TTS_TIMEOUT_MS = 30_000;

function buildPublicAudioUrl(audioPath?: string, fallbackAudioUrl?: string): string {
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl && audioPath) {
    const normalizedPath = audioPath.startsWith('/') ? audioPath : `/${audioPath}`;
    return new URL(normalizedPath, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
  }

  return fallbackAudioUrl ?? '';
}

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const ttsUrl = `${process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:8000'}/synthesize`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text, speaker_wav: 'default', language: 'en'}),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TTS service returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      audio_url?: string;
      audio_path?: string;
    };
    const audioUrl = buildPublicAudioUrl(data.audio_path, data.audio_url);

    if (!audioUrl) {
      throw new Error('TTS service response did not include audio_url');
    }

    return {
      audioUrl,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`TTS request timed out after ${TTS_TIMEOUT_MS}ms`);
    }
    logger.error({err, text}, 'TTS synthesis failed');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
