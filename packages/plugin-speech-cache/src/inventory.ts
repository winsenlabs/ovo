import { createHash } from 'node:crypto';
import {
  agentHandoffLines,
  agentTransferLines,
  agentLanguageLine,
  agentRecoveryLines,
  agentUnclearLines,
  canonicalJson,
  disclosureLines,
  endingLines,
  flowLineTemplates,
  turnDetectorLines,
  type AgentConfig,
  type DecisionOutcome,
  type TextFilter,
} from '@winsendotai/ovo-contracts';

export type FixedLineSource =
  | 'greeting'
  | 'opening'
  | 'voicemail'
  | 'processing'
  | 'clarification'
  | 'uncertainty'
  | 'faq'
  | 'decision'
  | 'flow'
  | 'script'
  | 'idle-prompt'
  | 'recovery'
  | 'guardrail'
  | 'filler'
  | 'disclosure'
  | 'opt-out'
  | 'wrap-up'
  | 'ending';

export interface FixedLine {
  text: string;
  source: FixedLineSource;
}

/**
 * The greet-first opening and the voicemail message (Wave 2 agent lane). Read structurally so the
 * inventory covers them as soon as the contract carries them, without depending on its ordering.
 */
type CallControlLines = {
  opening?: { lines?: readonly string[] };
  voicemail?: { action?: string; message?: string };
};

/** The release fields the inventory reads; ReleaseRecord satisfies it structurally. */
export interface SpeechInventoryRelease {
  config: AgentConfig;
  selections?: Readonly<Record<string, { config: Record<string, unknown> } | undefined>>;
}

export interface SpeechInventory {
  /** Exact configured lines with no `{{variables}}`: safe to render once and keep. */
  static: FixedLine[];
  /** Templated lines. They carry caller data once rendered and are never stored durably. */
  perCall: FixedLine[];
}

const TEMPLATE = /{{|}}/;

/** Every line a release can speak verbatim, walked from its immutable config (TTS-5). */
export function staticSpeechInventory(release: SpeechInventoryRelease): SpeechInventory {
  const { config } = release;
  const inventory: SpeechInventory = { static: [], perCall: [] };
  const seen = new Set<string>();
  const add = (text: string | undefined, source: FixedLineSource) => {
    if (!text?.trim() || seen.has(text)) return;
    seen.add(text);
    (TEMPLATE.test(text) ? inventory.perCall : inventory.static).push({ text, source });
  };
  add(config.message, 'greeting');
  // Collections compliance: the recording disclosure opens every call and the opt-out closing line
  // ends it; both are fixed lines, so both are clips before the first call.
  add(disclosureLines(config.compliance).join(' ').trim(), 'disclosure');
  if (config.compliance?.optOut?.enabled) add(config.compliance.optOut.closingLine, 'opt-out');
  // The engine's closing line before the call time limit (AgentEnding.wrapUp).
  add(config.ending?.wrapUp?.line, 'wrap-up');
  // Wave 10 (L2): with the LLM's end_call, "Shall I end the call?" and the lines a plain yes or no
  // to it gets, said without the model: each a clip, so the answer plays at once.
  if (config.ending?.llmTool) {
    const ending = endingLines(config.language);
    for (const line of ending ? [ending.ask, ending.goodbye, ending.resume] : [])
      add(line, 'ending');
  }
  const callControl = config as AgentConfig & CallControlLines;
  for (const line of callControl.opening?.lines ?? []) add(line, 'opening');
  // A message is only ever left when the action says so; a hang-up policy never speaks it.
  if (callControl.voicemail?.action === 'message') add(callControl.voicemail.message, 'voicemail');
  for (const processing of [config.processing, ...config.tools.map((tool) => tool.processing)]) {
    add(processing?.initial, 'processing');
    add(processing?.progress, 'processing');
    add(processing?.failure, 'processing');
  }
  add(config.clarification, 'clarification');
  // N4: asked of a caller heard outside the agent's languages.
  add(agentLanguageLine(config), 'recovery');
  add(config.uncertainty, 'uncertainty');
  // Call-3 #3: said instead of the uncertainty line to unclear words.
  for (const line of agentUnclearLines(config)) add(line, 'uncertainty');
  if (config.guardrail?.mode === 'block') add(config.guardrail.safeLine, 'guardrail');
  for (const entry of config.faq) add(entry.answer, 'faq');
  if (config.decision?.enabled)
    for (const outcome of decisionOutcomes(config.decision.questions)) add(outcome.say, 'decision');
  // A flow speaks each line as its own segment, so each line is its own clip (AGT-1).
  if (config.decision?.enabled && config.decision.flow)
    for (const line of flowLineTemplates(config.decision.flow)) add(line.template, 'flow');
  for (const node of config.script?.nodes ?? []) add(node.prompt, 'script');
  // Agent idle prompts and recovery lines (AGT-4, AGT-11, AGT-12): fixed lines are pre-rendered.
  for (const line of agentRecoveryLines(config))
    add(line.text, line.field.startsWith('idle.') ? 'idle-prompt' : 'recovery');
  // The line a fallback speaks before handing the caller to a person (AGT-15).
  for (const line of agentHandoffLines(config)) add(line.text, 'recovery');
  // R2: this agent's own transfer line and how it greets a transferred or returned caller.
  for (const line of agentTransferLines(config)) add(line.text, 'recovery');
  const turns = release.selections?.turnDetector;
  const detector = turns ? turnDetectorLines(turns.config) : { idle: [], filler: [] };
  for (const prompt of detector.idle) add(prompt, 'idle-prompt');
  // LAT-6: the detector's filler lines play while a slow reply is composed, each its own clip.
  for (const line of detector.filler) add(line, 'filler');
  return inventory;
}

/**
 * The templates an agent speaks first, before the caller says anything: its opening lines, then an
 * enabled flow's start-node lines (AGT-2, AGT-1). Their per-call renders are the ones worth having
 * ready before the call is answered (TTS-10).
 */
export function openingLineTemplates(config: AgentConfig): string[] {
  const callControl = config as AgentConfig & CallControlLines;
  const lines = [...(callControl.opening?.lines ?? [])];
  const flow = config.decision?.enabled ? config.decision.flow : undefined;
  const start = flow?.nodes.find((node) => node.id === flow.start);
  for (const id of start?.say ?? []) {
    const line = flow?.lines[id];
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

function decisionOutcomes(
  questions: NonNullable<AgentConfig['decision']>['questions'],
): DecisionOutcome[] {
  return questions.flatMap((question) =>
    question.type === 'choice'
      ? question.options.map((option) => option.outcome)
      : question.type === 'noul'
        ? [question.yes.outcome, question.no.outcome]
        : question.bands.map((band) => band.outcome),
  );
}

/**
 * Mirrors the speaker's filter chain (plugin-voice `filterSpeechText`): lowest `order` first, then
 * by id. Cache keys are computed on this output, so the two must never disagree (TTS-6).
 */
export function normalizeSpeechText(
  filters: readonly TextFilter[],
  text: string,
  language: string,
): string {
  const ordered = [...filters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const filter of ordered) text = filter.apply(text, { language });
  return text;
}

export interface NormalizedSpeechInventory {
  /** Post-filter text, unique, in inventory order. */
  texts: string[];
  /** Digest of the sorted texts: changes whenever any fixed line or filter output changes. */
  sha256: string;
  perCall: number;
}

export function normalizeSpeechInventory(
  inventory: SpeechInventory,
  filters: readonly TextFilter[],
  language: string,
): NormalizedSpeechInventory {
  const texts = [
    ...new Set(inventory.static.map((line) => normalizeSpeechText(filters, line.text, language))),
  ].filter((text) => text.trim());
  const sha256 = createHash('sha256')
    .update(canonicalJson([...texts].sort()))
    .digest('hex');
  return { texts, sha256, perCall: inventory.perCall.length };
}
