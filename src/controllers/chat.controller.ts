import type {Request, Response, NextFunction} from 'express';
import {performance} from 'node:perf_hooks';
import {ChatRequestSchema} from '../types/index.js';
import {getRelevantContext} from '../services/rag.service.js';
import {generateResponse} from '../services/llm.service.js';
import {synthesizeSpeech} from '../services/tts.service.js';
import {
  clearConversation,
  getMemoryContext,
  getMemoryInfo,
  normalizeSessionId,
  rememberTurn,
} from '../services/memory.service.js';
import logger from '../lib/logger.js';

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

export async function handleChat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const totalStart = performance.now();

  try {
    const {message, reset_memory: resetMemory, session_id: bodySessionId} = ChatRequestSchema.parse(req.body);
    const sessionId = normalizeSessionId(req.header('x-session-id') ?? bodySessionId);

    if (resetMemory) {
      clearConversation(sessionId);
    }

    logger.info({message, session_id: sessionId, reset_memory: Boolean(resetMemory)}, 'Received chat request');

    const memoryContext = getMemoryContext(sessionId);
    const memoryBefore = getMemoryInfo(sessionId);

    const ragStart = performance.now();
    const context = await getRelevantContext(message);
    const ragMs = elapsedMs(ragStart);

    const llmStart = performance.now();
    const llmResponse = await generateResponse(message, context, memoryContext);
    const llmMs = elapsedMs(llmStart);

    const ttsStart = performance.now();
    const ttsResult = await synthesizeSpeech(llmResponse.reply);
    const ttsMs = elapsedMs(ttsStart);
    const totalMs = elapsedMs(totalStart);
    const memoryAfter = rememberTurn(sessionId, message, llmResponse.reply, llmResponse.emotion);

    const timingMs = {
      rag: ragMs,
      llm: llmMs,
      tts: ttsMs,
      total: totalMs,
    };

    logger.info(
      {
        timing_ms: timingMs,
        context_used: context.length > 0,
        memory_used: memoryContext.length > 0,
        memory_turns_before: memoryBefore.turns,
        memory_turns_after: memoryAfter.length,
        session_id: sessionId,
        message_chars: message.length,
        reply_chars: llmResponse.reply.length,
      },
      'Chat request timing',
    );

    res.json({
      text: llmResponse.reply,
      metadata: {
        emotion: llmResponse.emotion,
        context_used: context.length > 0,
        memory_used: memoryContext.length > 0,
        memory_turns: memoryAfter.length,
        session_id: sessionId,
      },
      audio_url: ttsResult.audioUrl,
      timing_ms: timingMs,
    });
  } catch (err) {
    logger.warn({total_ms: elapsedMs(totalStart), err}, 'Chat request failed');
    next(err);
  }
}
