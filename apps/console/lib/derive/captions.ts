import type { RoomCaption } from '@winsendotai/ovo-ui/room';
import type { ConversationLine } from '../../components/ui/conversation';
import type { TicketContext } from '../types/desk';

/** Live captions kept in memory for one call; older lines fall off the front. */
export const MAX_CAPTION_LINES = 500;

export interface CaptionLine {
  id: string;
  role: RoomCaption['role'];
  text: string;
  final: boolean;
  at: number;
}

/**
 * Folds one caption into the transcript. A speaker's interim caption is replaced by their next
 * one (interim or final) until it finalises, so a sentence is one line that firms up, not a stack.
 */
export function applyCaption(lines: readonly CaptionLine[], caption: RoomCaption): CaptionLine[] {
  const last = lines.at(-1);
  const replaces = last !== undefined && !last.final && last.role === caption.role;
  const line: CaptionLine = {
    id: replaces ? last.id : `${caption.role}-${caption.at}-${lines.length}`,
    role: caption.role,
    text: caption.text,
    final: caption.final,
    at: caption.at,
  };
  const next = replaces ? [...lines.slice(0, -1), line] : [...lines, line];
  return next.length > MAX_CAPTION_LINES ? next.slice(next.length - MAX_CAPTION_LINES) : next;
}

/** Captions as `Conversation` lines, timed from the moment the operator joined. */
export function liveConversation(lines: readonly CaptionLine[], startedAt: number): ConversationLine[] {
  return lines.map((line) => ({
    id: line.id,
    speaker: line.role,
    atMs: Math.max(0, line.at - startedAt),
    text: line.text,
    interim: !line.final,
  }));
}

/** The turns the transferring agent heard before the handoff, shown above the live captions. */
export function handoverConversation(transcript: TicketContext['transcript']): ConversationLine[] {
  return transcript.map((turn, index) => ({
    id: `handover-${index}`,
    speaker: turn.role,
    text: turn.text,
  }));
}
