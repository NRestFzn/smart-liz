import { z } from "zod";

export const EmotionSchema = z.enum(["HAPPY", "ANGRY", "SAD", "EXCITED"]);

export const LlmResponseSchema = z.object({
  reply: z.string().min(1),
  emotion: EmotionSchema,
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
});

export const ChatResponseSchema = z.object({
  text: z.string(),
  audio_payload: z.string(),
  metadata: z.object({
    emotion: EmotionSchema,
    context_used: z.boolean(),
  }),
});

export type Emotion = z.infer<typeof EmotionSchema>;
export type LlmResponse = z.infer<typeof LlmResponseSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
