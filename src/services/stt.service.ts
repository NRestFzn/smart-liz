import logger from '../lib/logger.js';

const STT_TIMEOUT_MS = 30_000;
const STT_SAMPLE_RATE = 16_000;
const STT_CHANNELS = 1;
const STT_BITS = 16;

export interface TranscriptionResult {
  text: string;
  language: string;
  durationMs: number;
}

export interface TranscribeOptions {
  sampleRate?: number;
  signal?: AbortSignal;
  language?: string;
}

/**
 * Wrap raw PCM16-LE mono bytes in a RIFF/WAVE header so the TTS-Engine's
 * /transcribe endpoint can decode it. The firmware streams headerless PCM
 * upstream — we add the header right before forwarding to faster-whisper.
 */
function wrapPcmInWav(pcm: Buffer, sampleRate: number): Buffer {
  const dataSize = pcm.length;
  const byteRate = (sampleRate * STT_CHANNELS * STT_BITS) / 8;
  const blockAlign = (STT_CHANNELS * STT_BITS) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(STT_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(STT_BITS, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Send a PCM utterance to the STT service and return the transcript.
 *
 * `pcm` must be raw 16-bit signed little-endian mono samples. Sample rate
 * defaults to 16 kHz (the firmware capture rate) — override only if you're
 * pulling audio from a different source.
 */
export async function transcribePcm(
  pcm: Buffer,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const sampleRate = options.sampleRate ?? STT_SAMPLE_RATE;
  const baseUrl = process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:8000';
  const language = options.language ?? 'en';
  const sttUrl = `${baseUrl.replace(/\/+$/, '')}/transcribe?language=${encodeURIComponent(language)}`;

  const wav = wrapPcmInWav(pcm, sampleRate);

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), STT_TIMEOUT_MS);

  if (options.signal) {
    if (options.signal.aborted) {
      localController.abort();
    } else {
      options.signal.addEventListener('abort', () => localController.abort(), {once: true});
    }
  }

  try {
    // Node's undici fetch accepts Uint8Array at runtime, but the resolved
    // DOM BodyInit type doesn't include it (lib.dom + @types/node 22 mismatch).
    // Zero-copy view + cast at the boundary.
    const body = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength) as unknown as BodyInit;
    const response = await fetch(sttUrl, {
      method: 'POST',
      headers: {'Content-Type': 'audio/wav'},
      body,
      signal: localController.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`STT service returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      text?: string;
      language?: string;
      duration_ms?: number;
    };

    return {
      text: (data.text ?? '').trim(),
      language: data.language ?? language,
      durationMs: data.duration_ms ?? 0,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`STT request aborted or timed out after ${STT_TIMEOUT_MS}ms`);
    }
    logger.error({err, pcm_bytes: pcm.length}, 'STT transcription failed');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export {wrapPcmInWav};
