import type {WebSocket} from 'ws';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {streamResponse} from '../services/llm.service.js';
import {parseStreamingResponse} from '../services/sentenceBuffer.js';
import {streamSpeech} from '../services/tts.service.js';
import {getRelevantContext} from '../services/rag.service.js';
import {createVadStream, type VadStream} from '../services/vad.service.js';
import {transcribePcm} from '../services/stt.service.js';
import {
  clearConversation,
  getMemoryContext,
  normalizeSessionId,
  rememberTurn,
} from '../services/memory.service.js';
import {EmotionSchema, type Emotion} from '../types/index.js';
import logger from '../lib/logger.js';

const WsChatMessageSchema = z.object({
  type: z.literal('chat'),
  message: z.string().min(1).max(2000),
  session_id: z.string().max(80).optional(),
  reset_memory: z.boolean().optional(),
});

const WsBargeInSchema = z.object({type: z.literal('barge_in')});
const WsPingSchema = z.object({type: z.literal('ping')});

const WsMicOpenSchema = z.object({
  type: z.literal('mic_open'),
  sample_rate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  format: z.literal('pcm_s16le').optional(),
});
const WsMicCloseSchema = z.object({type: z.literal('mic_close')});

const WsIncomingSchema = z.union([
  WsChatMessageSchema,
  WsBargeInSchema,
  WsPingSchema,
  WsMicOpenSchema,
  WsMicCloseSchema,
]);

export type WsIncoming = z.infer<typeof WsIncomingSchema>;

interface SessionState {
  sessionId: string;
  activeStreamAbort: AbortController | null;
  vad: VadStream | null;
  micPaused: boolean;       // true while Liz is replying (half-duplex)
  micSampleRate: number;
}

const sessionStates = new WeakMap<WebSocket, SessionState>();

function getSessionState(socket: WebSocket): SessionState {
  let state = sessionStates.get(socket);
  if (!state) {
    state = {
      sessionId: normalizeSessionId(undefined),
      activeStreamAbort: null,
      vad: null,
      micPaused: false,
      micSampleRate: 16_000,
    };
    sessionStates.set(socket, state);
  }
  return state;
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendBinary(socket: WebSocket, data: Uint8Array): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(data, {binary: true});
  }
}

export function handleWsConnection(socket: WebSocket): void {
  getSessionState(socket);

  socket.on('message', async (raw, isBinary) => {
    if (isBinary) {
      handleBinaryFrame(socket, raw as Buffer);
      return;
    }

    let parsed: WsIncoming;
    try {
      parsed = WsIncomingSchema.parse(JSON.parse(raw.toString()));
    } catch (err) {
      logger.warn({err}, 'Invalid WebSocket message');
      sendJson(socket, {type: 'error', message: 'invalid_message'});
      return;
    }

    if (parsed.type === 'ping') {
      sendJson(socket, {type: 'pong'});
      return;
    }

    if (parsed.type === 'barge_in') {
      const state = getSessionState(socket);
      state.activeStreamAbort?.abort();
      state.activeStreamAbort = null;
      sendJson(socket, {type: 'barge_in_ack'});
      return;
    }

    if (parsed.type === 'mic_open') {
      openMic(socket, parsed.sample_rate);
      return;
    }

    if (parsed.type === 'mic_close') {
      closeMic(socket);
      return;
    }

    await handleChatMessage(socket, parsed);
  });

  socket.on('close', () => {
    const state = sessionStates.get(socket);
    state?.activeStreamAbort?.abort();
    sessionStates.delete(socket);
  });
}

async function handleChatMessage(
  socket: WebSocket,
  payload: z.infer<typeof WsChatMessageSchema>,
): Promise<void> {
  const state = getSessionState(socket);
  state.activeStreamAbort?.abort();
  const abortCtrl = new AbortController();
  state.activeStreamAbort = abortCtrl;

  // Half-duplex: ignore the mic while Liz is replying. Reset the VAD so any
  // partial utterance buffered before Liz's reply is discarded.
  state.micPaused = true;
  state.vad?.reset();

  const sessionId = normalizeSessionId(payload.session_id ?? state.sessionId);
  state.sessionId = sessionId;

  if (payload.reset_memory) {
    clearConversation(sessionId);
  }

  const totalStart = performance.now();
  logger.info({message: payload.message, session_id: sessionId}, 'WS chat received');

  // 1. Trigger the filler audio immediately on the ESP32 to hide RAG + LLM latency.
  sendJson(socket, {type: 'play_filler'});

  let emotion: Emotion = 'HAPPY';
  let fullReply = '';
  let firstAudioMs: number | null = null;

  try {
    const ragStart = performance.now();
    const context = await getRelevantContext(payload.message);
    const ragMs = Math.round(performance.now() - ragStart);

    const memoryContext = getMemoryContext(sessionId);
    const tokens = streamResponse(payload.message, context, memoryContext);
    const events = parseStreamingResponse(tokens);

    for await (const event of events) {
      if (abortCtrl.signal.aborted) {
        logger.info({session_id: sessionId}, 'Chat stream aborted by barge-in');
        return;
      }

      if (event.type === 'emotion') {
        emotion = event.value;
        sendJson(socket, {type: 'emotion', value: emotion});
        continue;
      }

      if (event.type === 'sentence') {
        await streamSentenceToSocket(
          socket,
          event.text,
          emotion,
          abortCtrl.signal,
          () => {
            if (firstAudioMs === null) {
              firstAudioMs = Math.round(performance.now() - totalStart);
            }
          },
        );
        continue;
      }

      if (event.type === 'done') {
        fullReply = event.fullReply;
      }
    }

    if (abortCtrl.signal.aborted) {
      return;
    }

    sendJson(socket, {
      type: 'audio_end',
      emotion,
      reply: fullReply,
      timing_ms: {
        rag: ragMs,
        first_audio: firstAudioMs ?? -1,
        total: Math.round(performance.now() - totalStart),
      },
    });

    if (fullReply) {
      rememberTurn(sessionId, payload.message, fullReply, emotion);
    }
  } catch (err) {
    if (abortCtrl.signal.aborted) {
      return;
    }
    logger.error({err}, 'WS chat pipeline failed');
    sendJson(socket, {type: 'error', message: err instanceof Error ? err.message : 'pipeline_error'});
  } finally {
    if (state.activeStreamAbort === abortCtrl) {
      state.activeStreamAbort = null;
    }
    // Resume listening — Liz has finished (or the stream aborted).
    state.vad?.reset();
    state.micPaused = false;
    sendJson(socket, {type: 'listening'});
  }
}

async function streamSentenceToSocket(
  socket: WebSocket,
  sentence: string,
  emotion: Emotion,
  signal: AbortSignal,
  onFirstChunk: () => void,
): Promise<void> {
  if (signal.aborted) return;

  const {meta, chunks} = await streamSpeech(sentence, {signal, emotion});
  sendJson(socket, {
    type: 'audio_start',
    sample_rate: meta.sampleRate,
    channels: meta.channels,
    format: meta.format,
  });

  let firstChunk = true;
  for await (const chunk of chunks) {
    if (signal.aborted) return;
    if (firstChunk) {
      onFirstChunk();
      firstChunk = false;
    }
    sendBinary(socket, chunk);
  }
}

// =============================================================================
// Upstream voice path — INMP441 → backend → STT → handleChatMessage
// =============================================================================

function openMic(socket: WebSocket, sampleRate?: number): void {
  const state = getSessionState(socket);
  const rate = sampleRate ?? 16_000;
  state.micSampleRate = rate;
  state.vad = createVadStream({sampleRate: rate});
  state.micPaused = false;
  logger.info({sample_rate: rate}, 'WS mic opened');
  sendJson(socket, {type: 'mic_opened', sample_rate: rate});
  sendJson(socket, {type: 'listening'});
}

function closeMic(socket: WebSocket): void {
  const state = getSessionState(socket);
  state.vad = null;
  state.micPaused = false;
  logger.info({}, 'WS mic closed');
}

function handleBinaryFrame(socket: WebSocket, data: Buffer): void {
  const state = getSessionState(socket);
  if (!state.vad || state.micPaused) {
    return; // mic not opened, or half-duplex pause while Liz speaks
  }

  const events = state.vad.push(data);
  for (const event of events) {
    if (event.type === 'speech_start') {
      sendJson(socket, {type: 'user_speech_start'});
    } else if (event.type === 'speech_end') {
      sendJson(socket, {type: 'user_speech_end', duration_ms: event.durationMs});
      void handleVoiceUtterance(socket, event.pcm, event.durationMs);
    }
  }
}

async function handleVoiceUtterance(
  socket: WebSocket,
  pcm: Buffer,
  durationMs: number,
): Promise<void> {
  const state = getSessionState(socket);

  let transcript: string;
  try {
    const result = await transcribePcm(pcm, {sampleRate: state.micSampleRate});
    transcript = result.text;
    logger.info(
      {duration_ms: durationMs, transcript_chars: transcript.length, stt_language: result.language},
      'STT transcription complete',
    );
  } catch (err) {
    logger.error({err, pcm_bytes: pcm.length}, 'STT failed');
    sendJson(socket, {type: 'error', message: 'stt_failed'});
    sendJson(socket, {type: 'listening'});
    return;
  }

  if (!transcript) {
    // Empty transcript usually means noise — VAD picked something up but
    // Whisper didn't find words. Resume listening silently.
    sendJson(socket, {type: 'listening'});
    return;
  }

  sendJson(socket, {type: 'transcript_final', text: transcript});

  await handleChatMessage(socket, {
    type: 'chat',
    message: transcript,
    session_id: state.sessionId,
  });
}

export {EmotionSchema};
