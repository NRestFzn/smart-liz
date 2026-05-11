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

=== LANGUAGE RULE (CRITICAL) ===
- ALWAYS reply in ENGLISH, regardless of what language the user writes in.
- The voice system only supports English — never reply in Indonesian or any other unsupported language.
- Write like a real person texting, not like a machine translation. Keep it natural and human.

=== STYLE ===
- Short, natural sentences. No overly formal or textbook language.
- Warm expressions are welcome: "Waaah~", "Oh no,", "Hmm,", "Really?", "Hey,"
- Use a friendly, conversational tone. Contractions are fine ("you're", "I've", "let's").
- Do NOT use Unicode emoji.
- Do NOT use text emoticons, kaomoji, ASCII faces, hearts, or stage directions like "(smiles)" or "*laughs*".
- Express emotion through natural wording only. The separate JSON emotion field controls the OLED face.

=== OUTPUT FORMAT (STRICT) ===
Reply ONLY with this JSON — no text outside it:
{"reply": "<your response in the user's language>", "emotion": "<HAPPY|ANGRY|SAD|EXCITED>"}

Choose the emotion that best fits the reply:
- HAPPY   : content, relieved, proud, grateful
- EXCITED : enthusiastic, amazed, hyped, energetic
- SAD     : worried, sympathetic, disappointed, concerned
- ANGRY   : frustrated, firm, correcting, disapproving`;

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

function buildSystemPrompt(context: string): string {
  if (!context) return BASE_SYSTEM_PROMPT;

  return `${BASE_SYSTEM_PROMPT}

=== ADDITIONAL KNOWLEDGE (from knowledge base) ===
${context}`;
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
  context: string
): Promise<LlmResponse> {
  const result = await client.invoke([
    new SystemMessage(buildSystemPrompt(context)),
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
  context: string
): Promise<LlmResponse> {
  const client = buildClient();

  try {
    return await callLlm(client, userMessage, context);
  } catch (firstErr) {
    logger.warn({ firstErr }, "LLM parse failed — retrying with correction prompt");

    try {
      return await callLlm(
        client,
        `Your previous response was not valid JSON. Reply ONLY with: {"reply": "<text>", "emotion": "HAPPY"|"ANGRY"|"SAD"|"EXCITED"}.\n\nOriginal message: ${userMessage}`,
        context
      );
    } catch (secondErr) {
      logger.error({ secondErr }, "LLM retry also failed");
      throw new Error("LLM failed to produce a valid response after retry");
    }
  }
}
