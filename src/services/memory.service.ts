import type {Emotion} from '../types/index.js';

export type ConversationTurn = {
  user: string;
  assistant: string;
  emotion: Emotion;
  createdAt: number;
};

const DEFAULT_SESSION_ID = 'default';
const MAX_TURNS = Number(process.env.MEMORY_MAX_TURNS ?? 20);
const MAX_TEXT_CHARS = Number(process.env.MEMORY_MAX_TEXT_CHARS ?? 600);

const conversations = new Map<string, ConversationTurn[]>();

function trimText(text: string, maxChars = MAX_TEXT_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

export function normalizeSessionId(value?: string | null): string {
  const sessionId = (value ?? '').trim();
  if (!sessionId) {
    return DEFAULT_SESSION_ID;
  }

  return sessionId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || DEFAULT_SESSION_ID;
}

export function getConversationTurns(sessionId: string): ConversationTurn[] {
  return conversations.get(normalizeSessionId(sessionId)) ?? [];
}

export function getMemoryContext(sessionId: string): string {
  const turns = getConversationTurns(sessionId);
  if (turns.length === 0) {
    return '';
  }

  return turns
    .map((turn, index) => {
      const n = index + 1;
      return [
        `Turn ${n}:`,
        `User: ${trimText(turn.user)}`,
        `Liz (${turn.emotion}): ${trimText(turn.assistant)}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function rememberTurn(
  sessionId: string,
  user: string,
  assistant: string,
  emotion: Emotion,
): ConversationTurn[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const turns = conversations.get(normalizedSessionId) ?? [];

  turns.push({
    user: trimText(user),
    assistant: trimText(assistant),
    emotion,
    createdAt: Date.now(),
  });

  if (turns.length > MAX_TURNS) {
    turns.splice(0, turns.length - MAX_TURNS);
  }

  conversations.set(normalizedSessionId, turns);
  return turns;
}

export function clearConversation(sessionId: string): void {
  conversations.delete(normalizeSessionId(sessionId));
}

export function getMemoryInfo(sessionId: string): {sessionId: string; turns: number; maxTurns: number} {
  const normalizedSessionId = normalizeSessionId(sessionId);

  return {
    sessionId: normalizedSessionId,
    turns: getConversationTurns(normalizedSessionId).length,
    maxTurns: MAX_TURNS,
  };
}
