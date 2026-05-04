import type { Request, Response, NextFunction } from "express";
import { ChatRequestSchema } from "../types/index.js";
import { getRelevantContext } from "../services/rag.service.js";
import { generateResponse } from "../services/llm.service.js";
import { synthesizeSpeech } from "../services/tts.service.js";
import logger from "../lib/logger.js";

export async function handleChat(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { message } = ChatRequestSchema.parse(req.body);

    logger.info({ message }, "Received chat request");

    const context = await getRelevantContext(message);
    const llmResponse = await generateResponse(message, context);
    const { audioBase64 } = await synthesizeSpeech(llmResponse.reply);

    res.json({
      text: llmResponse.reply,
      audio_payload: audioBase64,
      metadata: {
        emotion: llmResponse.emotion,
        context_used: context.length > 0,
      },
    });
  } catch (err) {
    next(err);
  }
}
