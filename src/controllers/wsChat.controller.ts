import type {WebSocket} from 'ws';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {streamResponse} from '../services/llm.service.js';
import {parseStreamingResponse} from '../services/sentenceBuffer.js';
import {streamSpeech} from '../services/tts.service.js';
import {getRelevantContext} from '../services/rag.service.js';
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

const WsIncomingSchema = z.union([WsChatMessageSchema, WsBargeInSchema, WsPingSchema]);

export type WsIncoming = z.infer<typeof WsIncomingSchema>;

interface SessionState {
  sessionId: string;
  activeStreamAbort: AbortController | null;
}

const sessionStates = new WeakMap<WebSocket, SessionState>();

function getSessionState(socket: WebSocket): SessionState {
  let state = sessionStates.get(socket);
  if (!state) {
    state = {
      sessionId: normalizeSessionId(undefined),
      activeStreamAbort: null,
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

export {EmotionSchema};
