interface TtsResult {
  audioBase64: string;
}

import logger from '../lib/logger.js';

const TTS_TIMEOUT_MS = 30_000;

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
      audio_base64?: string;
      audio?: string;
    };
    const audioBase64 = data.audio_base64 ?? data.audio ?? '';

    return {audioBase64};
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
