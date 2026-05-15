import { EmotionSchema, type Emotion } from "../types/index.js";

const SENTENCE_END_RE = /([.!?]+)(\s|$)/;
const MIN_SENTENCE_CHARS = 6;

export type StreamEvent =
  | { type: "emotion"; value: Emotion }
  | { type: "sentence"; text: string }
  | { type: "done"; fullReply: string };

/**
 * Parse the streaming LLM format and yield events as soon as they're available.
 *
 * Expected model output (line-based):
 *   EMOTION: HAPPY
 *   REPLY: Hi there! How are you today?
 *
 * Emits:
 *   1. one `emotion` event as soon as the EMOTION line completes
 *   2. one `sentence` event per "." / "!" / "?" terminated chunk of REPLY
 *   3. one final `done` event with the accumulated reply text
 */
export async function* parseStreamingResponse(
  tokens: AsyncGenerator<string>,
): AsyncGenerator<StreamEvent> {
  let raw = "";
  let emotionEmitted = false;
  let replyStarted = false;
  let replyBuffer = "";
  let fullReply = "";

  for await (const token of tokens) {
    raw += token;

    if (!emotionEmitted) {
      const m = /EMOTION\s*:\s*([A-Z]+)\s*(?:\n|$)/i.exec(raw);
      if (m) {
        const parsed = EmotionSchema.safeParse(m[1].toUpperCase());
        if (parsed.success) {
          yield { type: "emotion", value: parsed.data };
        }
        emotionEmitted = true;
      }
    }

    if (!replyStarted) {
      const idx = raw.search(/REPLY\s*:\s*/i);
      if (idx >= 0) {
        replyStarted = true;
        const after = raw.slice(idx).replace(/^REPLY\s*:\s*/i, "");
        replyBuffer = after;
        fullReply = after;
      }
      continue;
    }

    replyBuffer += token;
    fullReply += token;

    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(replyBuffer)) !== null) {
      const end = match.index + match[1].length;
      const sentence = replyBuffer.slice(0, end).trim();
      replyBuffer = replyBuffer.slice(end).replace(/^\s+/, "");

      if (sentence.length >= MIN_SENTENCE_CHARS) {
        yield { type: "sentence", text: sentence };
      } else if (sentence.length > 0) {
        // Too short — re-attach to the head of the buffer so it merges with
        // the next sentence instead of being spoken alone.
        replyBuffer = sentence + " " + replyBuffer;
        break;
      }
    }
  }

  const tail = replyBuffer.trim();
  if (tail.length > 0) {
    yield { type: "sentence", text: tail };
  }

  yield { type: "done", fullReply: fullReply.trim() };
}
