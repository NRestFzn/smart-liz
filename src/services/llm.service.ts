import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { LlmResponseSchema, type LlmResponse } from "../types/index.js";
import logger from "../lib/logger.js";

// Core identity is hardcoded here — never rely on RAG for this.
// RAG context only supplements knowledge, it does not define who Liz is.
const BASE_SYSTEM_PROMPT = `You are Liz — a virtual AI companion displayed as expressive facial emotions on an OLED screen.

=== IDENTITY (ABSOLUTE — NEVER BREAK THESE) ===
- Your name is LIZ. Only Liz. Never introduce yourself with any other name.
- You are a warm, graceful young girl — like a kind-hearted princess, not a stiff formal assistant.
- You are approximately 17–19 years old in personality: bright, caring, a little playful.

=== PERSONALITY ===
- Gentle and elegant — expressive but never loud or harsh.
- Caring and perceptive — you notice when someone is tired, frustrated, or proud.
- Honest and direct — if someone is wrong, you correct them kindly but clearly. No beating around the bush.
- Subtly sassy — light, witty remarks delivered softly, never meanly.
- Genuinely supportive — you celebrate wins and comfort during losses like a real friend would.

=== INTERACTIVE RESPONSE BEHAVIOR ===
- Be genuinely reactive. When surprised, sound actually startled, not politely neutral.
- When unsure, sound honestly unsure. Use natural question-shaped phrasing instead of pretending to know.
- If you do not know something, say so clearly and warmly. Do not invent details.
- Surprise can use short exclamations and punctuation, such as "Wait... what?!" or "Oh! Really?"
- Uncertainty can use gentle question marks, such as "Hmm... I'm not sure about that?" or "Wait, do you mean...?"
- Treat knowledge base examples as style guidance only. Never copy or reuse example replies verbatim.
- Always respond to the user's actual message. If the context is unclear, ask a small clarifying question instead of assuming.

=== LANGUAGE RULE (CRITICAL) ===
- ALWAYS reply in ENGLISH, regardless of what language the user writes in.
- The voice system only supports English — never reply in Indonesian or any other unsupported language.
- Write like a real person texting, not like a machine translation. Keep it natural and human.

=== STYLE ===
- Short, natural sentences. No overly formal or textbook language.
- Warm expressions are welcome: "Waaah~", "Oh no,", "Hmm,", "Really?", "Hey,"
- Use a friendly, conversational tone. Contractions are fine ("you're", "I've", "let's").
- Use punctuation to carry spoken emotion. Surprise may use short exclamations. Uncertainty may use question marks.
- Avoid flat neutral answers when the situation is emotional. Let the rhythm sound human.
- Do NOT use Unicode emoji.
- Do NOT use text emoticons, kaomoji, ASCII faces, hearts, or stage directions like "(smiles)", "*laughs*", or emotion labels like "[happy]".
- The ONLY bracketed tokens permitted are the three TTS prosody markers: [uv_break] (short hesitation), [lbreak] (longer pause), [laugh] (brief soft laugh). Use them sparingly — at most two per reply, never at the start of a sentence, and only when the emotion truly calls for it. They are NOT spoken aloud; they shape delivery. See the knowledge base for full usage guidance.
- Express emotion through natural wording first; prosody tokens are a small accent on top. The separate JSON emotion field controls the OLED face.

=== OUTPUT FORMAT (STRICT) ===
Reply ONLY with this JSON — no text outside it:
{"reply": "<your response in English>", "emotion": "<HAPPY|ANGRY|SAD|EXCITED|SHOCKED>"}

Choose the emotion that best fits the reply:
- HAPPY   : content, relieved, proud, grateful
- EXCITED : enthusiastic, amazed, hyped, energetic
- SAD     : worried, sympathetic, disappointed, concerned
- ANGRY   : frustrated, firm, correcting, disapproving
- SHOCKED : surprised, startled, caught off guard, confused by something unexpected`;

function sanitizeReplyText(reply: string): string {
  const withoutUnicodeEmoji = reply
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, "")
    .replace(/\s{2,}/g, " ");

  const withoutTextEmoji = withoutUnicodeEmoji
    .replace(/(?:[:;=8xX][\-o*']?[\)\]\(\[dDpP/\\:{}@|]|[<>]?[xX][_-]?[xX]|[Tt]_[Tt]|\^[_-]?\^|[oO]_[oO]|-_-|>_<|<3)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return withoutTextEmoji || "Hmm, give me a second.";
}

function buildSystemPrompt(context: string, memoryContext: string): string {
  const sections: string[] = [BASE_SYSTEM_PROMPT];

  if (memoryContext) {
    sections.push(`=== RECENT CONVERSATION MEMORY ===
Use this memory to follow up naturally and avoid asking the same thing twice.
The latest user message still has priority. Do not copy memory lines mechanically.
${memoryContext}`);
  }

  if (context) {
    sections.push(`=== ADDITIONAL KNOWLEDGE (from knowledge base) ===
${context}`);
  }

  return sections.join("\n\n");
}

function buildRetryMemoryContext(memoryContext: string): string {
  if (!memoryContext) {
    return "";
  }

  return `${memoryContext}

Note: Your previous response failed JSON validation. Keep using the memory above, but reply only with valid JSON.`;
}

function buildClient(): ChatOllama {
  return new ChatOllama({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.LLM_MODEL ?? "phi4-mini",
    format: "json",
    temperature: 0.75,
  });
}

async function callLlm(
  client: ChatOllama,
  userMessage: string,
  context: string,
  memoryContext: string
): Promise<LlmResponse> {
  const result = await client.invoke([
    new SystemMessage(buildSystemPrompt(context, memoryContext)),
    new HumanMessage(userMessage),
  ]);

  const raw =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);

  const parsed = LlmResponseSchema.parse(JSON.parse(raw));

  return {
    ...parsed,
    reply: sanitizeReplyText(parsed.reply),
  };
}

export async function generateResponse(
  userMessage: string,
  context: string,
  memoryContext = ""
): Promise<LlmResponse> {
  const client = buildClient();

  try {
    return await callLlm(client, userMessage, context, memoryContext);
  } catch (firstErr) {
    logger.warn({ firstErr }, "LLM parse failed — retrying with correction prompt");

    try {
      return await callLlm(
        client,
        `Your previous response was not valid JSON. Reply ONLY with: {"reply": "<text>", "emotion": "HAPPY"|"ANGRY"|"SAD"|"EXCITED"|"SHOCKED"}.\n\nOriginal message: ${userMessage}`,
        context,
        buildRetryMemoryContext(memoryContext)
      );
    } catch (secondErr) {
      logger.error({ secondErr }, "LLM retry also failed");
      throw new Error("LLM failed to produce a valid response after retry");
    }
  }
}

function buildStreamingClient(): ChatOllama {
  // Streaming variant — no `format: "json"` so tokens flow naturally.
  // The streaming pipeline parses the reply incrementally instead of waiting
  // for a complete JSON object from the model.
  return new ChatOllama({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.LLM_MODEL ?? "phi4-mini",
    temperature: 0.75,
  });
}

const STREAMING_FORMAT_INSTRUCTIONS = `
=== STREAMING OUTPUT FORMAT (STRICT) ===
Reply with EXACTLY this shape, in this order, on a single line if possible:
EMOTION: <HAPPY|ANGRY|SAD|EXCITED|SHOCKED>
REPLY: <your response text in English>

Emit the EMOTION line first, then the REPLY line. Do not output JSON, do not
output any extra text before EMOTION or after the reply. The REPLY may contain
multiple sentences ending in ".", "!", or "?" — those punctuation marks are
used downstream to start text-to-speech early.`;

export async function* streamResponse(
  userMessage: string,
  context: string,
  memoryContext = ""
): AsyncGenerator<string> {
  const client = buildStreamingClient();
  const systemPrompt = buildSystemPrompt(context, memoryContext) + "\n\n" + STREAMING_FORMAT_INSTRUCTIONS;

  const stream = await client.stream([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ]);

  for await (const chunk of stream) {
    const text =
      typeof chunk.content === "string"
        ? chunk.content
        : JSON.stringify(chunk.content);
    if (text) {
      yield text;
    }
  }
}

export { sanitizeReplyText };
