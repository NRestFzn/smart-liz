import type {Request, Response, NextFunction} from 'express';
import {performance} from 'node:perf_hooks';
import {ChatRequestSchema} from '../types/index.js';
import {getRelevantContext} from '../services/rag.service.js';
import {generateResponse} from '../services/llm.service.js';
import {synthesizeSpeech} from '../services/tts.service.js';
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
    const {message} = ChatRequestSchema.parse(req.body);

    logger.info({message}, 'Received chat request');

    const ragStart = performance.now();
    const context = await getRelevantContext(message);
    const ragMs = elapsedMs(ragStart);

    const llmStart = performance.now();
    const llmResponse = await generateResponse(message, context);
    const llmMs = elapsedMs(llmStart);

    const ttsStart = performance.now();
    const ttsResult = await synthesizeSpeech(llmResponse.reply);
    const ttsMs = elapsedMs(ttsStart);
    const totalMs = elapsedMs(totalStart);

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
      },
      audio_url: ttsResult.audioUrl,
      timing_ms: timingMs,
    });
  } catch (err) {
    logger.warn({total_ms: elapsedMs(totalStart), err}, 'Chat request failed');
    next(err);
  }
}
