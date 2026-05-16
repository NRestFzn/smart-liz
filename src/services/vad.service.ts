/**
 * Voice-Activity Detection over a streaming PCM source.
 *
 * Phase 1: simple RMS-energy VAD with hysteresis (silence hangover + min
 * speech length). No external dependency, no model file. Tuned for a quiet
 * room with an INMP441 ~30 cm from the speaker.
 *
 * The event shape (`speech_start` / `speech_end` with a PCM payload) is
 * deliberately identical to what a Silero-backed implementation would emit,
 * so the upgrade path is a single-file swap if energy VAD proves too noisy.
 *
 * One VadStream per WebSocket session — state is per-stream.
 */

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_FRAME_MS = 30;
const DEFAULT_THRESHOLD = 0.015;          // normalized RMS (s16 → [-1, 1])
const DEFAULT_SILENCE_HANGOVER_MS = 500;  // silence after speech → speech_end
const DEFAULT_MIN_SPEECH_MS = 200;        // utterances shorter than this are dropped
const DEFAULT_MAX_UTTERANCE_MS = 15_000;  // safety cap

export type VadEvent =
  | {type: 'speech_start'}
  | {type: 'speech_end'; pcm: Buffer; durationMs: number};

export interface VadOptions {
  sampleRate?: number;
  frameDurationMs?: number;
  speechThreshold?: number;
  silenceHangoverMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

export interface VadStream {
  /** Feed inbound PCM bytes. Returns any events fired by this batch. */
  push(pcm: Buffer): VadEvent[];
  /** Force speech_end if currently speaking (e.g., WS closing). */
  flush(): VadEvent[];
  /** Drop all buffered audio + state. Used for half-duplex pause/resume. */
  reset(): void;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const ENV_THRESHOLD = envNumber('VAD_SPEECH_THRESHOLD', DEFAULT_THRESHOLD);
const ENV_SILENCE_HANGOVER_MS = envNumber('VAD_SILENCE_HANGOVER_MS', DEFAULT_SILENCE_HANGOVER_MS);
const ENV_MIN_SPEECH_MS = envNumber('VAD_MIN_SPEECH_MS', DEFAULT_MIN_SPEECH_MS);
const ENV_MAX_UTTERANCE_MS = envNumber('VAD_MAX_UTTERANCE_MS', DEFAULT_MAX_UTTERANCE_MS);

export function createVadStream(opts: VadOptions = {}): VadStream {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const frameMs = opts.frameDurationMs ?? DEFAULT_FRAME_MS;
  const threshold = opts.speechThreshold ?? ENV_THRESHOLD;
  const silenceHangoverMs = opts.silenceHangoverMs ?? ENV_SILENCE_HANGOVER_MS;
  const minSpeechMs = opts.minSpeechMs ?? ENV_MIN_SPEECH_MS;
  const maxUtteranceMs = opts.maxUtteranceMs ?? ENV_MAX_UTTERANCE_MS;

  const samplesPerFrame = Math.round((sampleRate * frameMs) / 1000);
  const bytesPerFrame = samplesPerFrame * 2; // s16le mono

  let frameBuffer: Buffer = Buffer.alloc(0); // unprocessed input
  let utterance: Buffer[] = [];      // accumulated frames since speech_start
  let speaking = false;
  let silenceMs = 0;
  let speechMs = 0;
  let utteranceMs = 0;

  function computeRms(frame: Buffer): number {
    const samples = frame.length / 2;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const sample = frame.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
  }

  function resetState() {
    speaking = false;
    silenceMs = 0;
    speechMs = 0;
    utteranceMs = 0;
    utterance = [];
  }

  function finalize(): VadEvent[] {
    const pcm = Buffer.concat(utterance);
    const durationMs = utteranceMs;
    resetState();
    return [{type: 'speech_end', pcm, durationMs}];
  }

  function processFrame(frame: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    const isSpeech = computeRms(frame) > threshold;

    if (isSpeech) {
      if (!speaking) {
        speaking = true;
        resetState();
        speaking = true;
        events.push({type: 'speech_start'});
      }
      utterance.push(frame);
      utteranceMs += frameMs;
      speechMs += frameMs;
      silenceMs = 0;

      if (utteranceMs >= maxUtteranceMs) {
        events.push(...finalize());
      }
      return events;
    }

    if (!speaking) {
      return events; // silence before speech → ignore
    }

    // Trailing silence — keep it in the buffer (Whisper handles boundaries
    // better with a bit of tail), but count it against the hangover budget.
    utterance.push(frame);
    utteranceMs += frameMs;
    silenceMs += frameMs;

    if (silenceMs >= silenceHangoverMs) {
      if (speechMs >= minSpeechMs) {
        events.push(...finalize());
      } else {
        resetState(); // blip too short — drop silently
      }
    }
    return events;
  }

  return {
    push(pcm: Buffer): VadEvent[] {
      const events: VadEvent[] = [];
      frameBuffer = frameBuffer.length === 0 ? pcm : Buffer.concat([frameBuffer, pcm]);

      while (frameBuffer.length >= bytesPerFrame) {
        const frame = Buffer.from(frameBuffer.subarray(0, bytesPerFrame));
        frameBuffer = frameBuffer.subarray(bytesPerFrame);
        events.push(...processFrame(frame));
      }
      return events;
    },

    flush(): VadEvent[] {
      if (speaking && speechMs >= minSpeechMs) {
        return finalize();
      }
      resetState();
      return [];
    },

    reset(): void {
      frameBuffer = Buffer.alloc(0);
      resetState();
    },
  };
}
