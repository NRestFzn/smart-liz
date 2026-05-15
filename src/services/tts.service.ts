interface TtsResult {
  audioUrl: string;
}

import logger from '../lib/logger.js';

const TTS_TIMEOUT_MS = 30_000;
const TTS_STREAM_TIMEOUT_MS = 60_000;

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

export interface PcmStreamMeta {
  sampleRate: number;
  channels: number;
  format: 'pcm_s16le';
}

export interface PcmStreamResult {
  meta: PcmStreamMeta;
  chunks: AsyncIterable<Uint8Array>;
}

export interface StreamSpeechOptions {
  signal?: AbortSignal;
  emotion?: string;
}

/**
 * Stream raw PCM bytes from the TTS service for the given sentence.
 *
 * The returned `chunks` iterator yields binary chunks as they arrive from
 * the streaming engine (XTTS or ChatTTS — see plan.md §13). The optional
 * `emotion` is forwarded as-is; XTTS ignores it, ChatTTS maps it to a
 * RefineText prompt.
 */
export async function streamSpeech(
  text: string,
  options: StreamSpeechOptions = {},
): Promise<PcmStreamResult> {
  const {signal, emotion} = options;
  const ttsUrl = `${process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:8000'}/synthesize_stream`;

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TTS_STREAM_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) {
      localController.abort();
    } else {
      signal.addEventListener('abort', () => localController.abort(), {once: true});
    }
  }

  let response: Response;
  try {
    response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text,
        speaker_wav: 'default',
        language: 'en',
        emotion: emotion ?? 'HAPPY',
      }),
      signal: localController.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('TTS stream aborted before any audio arrived');
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    const body = await response.text().catch(() => '');
    throw new Error(`TTS stream returned ${response.status}: ${body}`);
  }

  const meta: PcmStreamMeta = {
    sampleRate: Number(response.headers.get('x-sample-rate') ?? 24000),
    channels: Number(response.headers.get('x-channels') ?? 1),
    format: 'pcm_s16le',
  };

  const body = response.body;

  const chunks: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return {meta, chunks};
}
