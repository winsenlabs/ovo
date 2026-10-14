// The scorecard's metrics as the report, the diff and the gate see them: label, unit, which way
// is better, and whether a gold transcript is needed.

export interface MetricSpec {
  key: string;
  label: string;
  unit: 'count' | 'rate' | 'ms' | 'ratio';
  /** Which way is better; `info` is never gated. */
  better: 'lower' | 'higher' | 'info';
  /** Needs a gold transcript. */
  gold?: boolean;
}

export const METRICS: readonly MetricSpec[] = [
  { key: 'answeredTurns', label: 'Caller turns answered', unit: 'count', better: 'info' },
  { key: 'resetTurns', label: 'Turns dropped as backchannels', unit: 'count', better: 'info' },
  {
    key: 'uncoveredSegments',
    label: 'Caller segments no turn answered',
    unit: 'count',
    better: 'lower',
  },
  {
    key: 'uncoveredSegmentRate',
    label: 'Caller segments no turn answered (share)',
    unit: 'rate',
    better: 'lower',
  },
  {
    key: 'quickRestarts',
    label: 'Turns begun <1 s after the last ended',
    unit: 'count',
    better: 'lower',
  },
  {
    key: 'goldThoughts',
    label: 'Caller thoughts (gold)',
    unit: 'count',
    better: 'info',
    gold: true,
  },
  { key: 'splitRate', label: 'Split rate', unit: 'rate', better: 'lower', gold: true },
  {
    key: 'extraTurns',
    label: 'Extra turns from splits',
    unit: 'count',
    better: 'lower',
    gold: true,
  },
  { key: 'mergeRate', label: 'Merge rate', unit: 'rate', better: 'lower', gold: true },
  { key: 'falseEndpoints', label: 'False endpoints', unit: 'count', better: 'lower', gold: true },
  {
    key: 'falseEndpointRate',
    label: 'False endpoints per turn',
    unit: 'rate',
    better: 'lower',
    gold: true,
  },
  { key: 'phantomTurns', label: 'Turns on no thought', unit: 'count', better: 'lower', gold: true },
  {
    key: 'droppedThoughts',
    label: 'Thoughts no turn ended',
    unit: 'count',
    better: 'lower',
    gold: true,
  },
  { key: 'endpointP50Ms', label: 'Endpoint latency p50', unit: 'ms', better: 'lower', gold: true },
  { key: 'endpointP90Ms', label: 'Endpoint latency p90', unit: 'ms', better: 'lower', gold: true },
  {
    key: 'discardedReplies',
    label: 'Replies composed, none heard',
    unit: 'count',
    better: 'lower',
  },
  { key: 'discardedLines', label: 'Reply lines discarded unheard', unit: 'count', better: 'lower' },
  { key: 'cutLines', label: 'Reply lines cut off', unit: 'count', better: 'lower' },
  { key: 'llmRequests', label: 'LLM requests', unit: 'count', better: 'lower' },
  {
    key: 'llmPerThought',
    label: 'LLM requests per thought',
    unit: 'ratio',
    better: 'lower',
    gold: true,
  },
  { key: 'llmPerTurn', label: 'LLM requests per answered turn', unit: 'ratio', better: 'lower' },
  { key: 'talkOver', label: 'Agent started over the caller', unit: 'count', better: 'lower' },
  { key: 'talkOverMs', label: 'Talk-over time', unit: 'ms', better: 'lower' },
  {
    key: 'missedReplies',
    label: 'Thoughts with no audible reply',
    unit: 'count',
    better: 'lower',
    gold: true,
  },
  {
    key: 'missedTurnReplies',
    label: 'Turns with no audible reply',
    unit: 'count',
    better: 'lower',
  },
  { key: 'cannedLines', label: 'Canned/fallback lines heard', unit: 'count', better: 'lower' },
  { key: 'fillers', label: 'Fillers heard', unit: 'count', better: 'lower' },
  { key: 'firstAudioP50Ms', label: 'First audio after the turn p50', unit: 'ms', better: 'lower' },
  { key: 'firstAudioP90Ms', label: 'First audio after the turn p90', unit: 'ms', better: 'lower' },
  { key: 'firstAnswerP50Ms', label: 'First answer audio p50', unit: 'ms', better: 'lower' },
  { key: 'firstAnswerP90Ms', label: 'First answer audio p90', unit: 'ms', better: 'lower' },
  {
    key: 'replyLatencyP50Ms',
    label: 'Reply after last word (gold) p50',
    unit: 'ms',
    better: 'lower',
    gold: true,
  },
  {
    key: 'replyLatencyP90Ms',
    label: 'Reply after last word (gold) p90',
    unit: 'ms',
    better: 'lower',
    gold: true,
  },
  { key: 'wer', label: 'STT WER', unit: 'rate', better: 'lower', gold: true },
  { key: 'cer', label: 'STT CER', unit: 'rate', better: 'lower', gold: true },
  {
    key: 'foreignSegments',
    label: 'Transcripts in a wrong language',
    unit: 'count',
    better: 'lower',
  },
  { key: 'foreignInterims', label: 'Interims in a wrong language', unit: 'count', better: 'lower' },
  {
    key: 'languageMismatches',
    label: 'Utterances misdetected (gold)',
    unit: 'count',
    better: 'lower',
    gold: true,
  },
];
