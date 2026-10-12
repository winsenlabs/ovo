/** The agent's name and how STT has misheard it, from the agent's `voice.stt.config` (Wave 8). */
export interface AgentNameConfig {
  /** The name the agent introduces itself with ("Maya"): favoured as a keyterm on every call. */
  agentName?: string;
  /** Words STT has written for that name ("Danny"), restored where the caller addresses the agent. */
  agentNameMishearings?: readonly string[];
}

/**
 * Words a caller addresses the agent after: thanks, greetings, acknowledgements, in English and
 * Hinglish. A name right after one of these, ending its clause, is the agent being spoken to.
 */
const ADDRESS = [
  'thank you',
  'thank you so much',
  'thanks',
  'thank u',
  'hi',
  'hello',
  'hey',
  'bye',
  'goodbye',
  'ok',
  'okay',
  'yes',
  'yeah',
  'no',
  'sorry',
  'please',
  'haan',
  'ji',
  'accha',
  'achha',
  'shukriya',
  'dhanyavaad',
  'dhanyavad',
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wave 8 (call 6e1a4e3a: "Okay. Thank you, Danny." to Maya): restores the agent's name where a
 * listed mishearing stands in address, right after thanks, a greeting or an acknowledgement and
 * ending its clause ("Thank you, Danny.", "hi danny"), or (Wave 8b, call e8a43f65: "Ma'am, create a
 * call.") opening a sentence before a comma, as a caller calls the agent by name before asking
 * something. Anywhere else the word is left alone: a caller may well talk about a Danny, or call
 * the agent "ma'am" mid-sentence. Undefined when there is nothing to restore.
 */
export function agentNameRestorer(config: AgentNameConfig): ((text: string) => string) | undefined {
  const name = config.agentName?.trim();
  const misheard = (config.agentNameMishearings ?? [])
    .map((word) => word.trim())
    .filter((word) => word && word.toLowerCase() !== name?.toLowerCase());
  if (!name || !misheard.length) return undefined;
  // "Ma'am" matches "Ma’am": STTs write either apostrophe.
  const names = misheard.map((word) => escape(word).replace(/['’]/gu, "['’]")).join('|');
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{M}])(${ADDRESS.map(escape).join('|')})([,!]?\\s+)` +
      `(${names})(?=\\s*(?:[.,!?…]|$))`,
    'giu',
  );
  const opening = new RegExp(`(^\\s*|[.!?…]\\s+)(?:${names})(?=,\\s*[\\p{L}\\p{M}])`, 'giu');
  return (text) =>
    text
      .replace(pattern, (_, before, address, gap) => before + address + gap + name)
      .replace(opening, (_, before) => before + name);
}
