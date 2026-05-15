import {z} from 'zod';

export const EmotionSchema = z.enum(['HAPPY', 'ANGRY', 'SAD', 'EXCITED', 'SHOCKED']);

export const LlmResponseSchema = z.object({
  reply: z.string().min(1),
  emotion: EmotionSchema,
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  session_id: z.string().min(1).max(80).optional(),
  reset_memory: z.boolean().optional(),
});

export const ChatResponseSchema = z.object({
  text: z.string(),
  metadata: z.object({
    emotion: EmotionSchema,
    context_used: z.boolean(),
    memory_used: z.boolean(),
    memory_turns: z.number(),
    session_id: z.string(),
  }),
  audio_url: z.string().url(),
  timing_ms: z.object({
    rag: z.number(),
    llm: z.number(),
    tts: z.number(),
    total: z.number(),
  }),
});

export type Emotion = z.infer<typeof EmotionSchema>;
export type LlmResponse = z.infer<typeof LlmResponseSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
