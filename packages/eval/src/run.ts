// One harness run over a corpus: each call scored as it happened live, replayed from its
// transcripts, or replayed from its audio through a live STT; then the scorecard.
import type { Inference, NetPort, SpeechToText } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { openAiInference } from '@winsendotai/ovo-plugin-llm-openai';
import { readKeys, sttConfig, sttStatus } from './audio/stt-configs.ts';
import { loadCorpus, type CorpusCall } from './corpus/load.ts';
import { summaryTimeline } from './log/summaries.ts';
import { replayAudio } from './replay/audio.ts';
import { chooseDetector } from './replay/detectors.ts';
import { replayTranscript, type ReplayResult } from './replay/transcript.ts';
import { scoreCall, scorecard, type CallScore, type Scorecard } from './score/scorecard.ts';
import { buildTimeline, type CallTimeline, type Transcript } from './timeline.ts';

export type Mode = 'live' | 'transcript' | 'audio';

export interface RunOptions {
  corpus: string;
  calls?: string[];
  mode: Mode;
  label: string;
  /** `rules` or `module:<path>[#export]`. */
  detector?: string;
  detectorConfig?: Record<string, unknown>;
  vad?: 'trace' | 'audio';
  /** Audio mode: an STT config id (`eval:calls stt-configs`). */
  stt?: string;
  keysFile?: string;
  /** Audio mode only: a live LLM (OVO_EVAL_OPENAI_API_KEY in the keys file) of this model. */
  llmModel?: string;
  /** Transcript mode: another STT's transcripts per call (an audio run's `transcripts/`). */
  transcripts?: Record<string, Transcript[]>;
  config?: Record<string, unknown>;
  log?: (line: string) => void;
}

export interface RunResult {
  card: Scorecard;
  /** Audio mode: what the STT wrote per call, for transcript replays of other detectors. */
  transcripts: Record<string, { stt: string; transcripts: Transcript[] }>;
}

interface LivePorts {
  stt: () => SpeechToText;
  inference?: Inference;
}

function liveTimeline(call: CorpusCall): CallTimeline {
  return call.events
    ? buildTimeline(call.events.engine, call.events.llm)
    : summaryTimeline(call.summaries!);
}

/** The audio mode's provider ports, refusing a config whose key is missing. */
async function livePorts(
  options: RunOptions,
  net: NetPort,
  config: Record<string, unknown>,
): Promise<LivePorts> {
  const chosen = sttConfig(options.stt ?? 'scribe-auto');
  const keys = options.keysFile ? await readKeys(options.keysFile) : {};
  const status = sttStatus(chosen, keys);
  if (status !== 'ready') throw new Error(`STT ${chosen.id} is ${status} (${chosen.keyEnv})`);
  config.stt = `${chosen.id}: ${chosen.description}`;
  const ports: LivePorts = { stt: () => chosen.create!(net, keys[chosen.keyEnv]!) };
  if (options.llmModel) {
    const key = keys.OVO_EVAL_OPENAI_API_KEY ?? keys.OPENAI_API_KEY;
    if (!key) throw new Error('a live LLM needs OVO_EVAL_OPENAI_API_KEY in the keys file');
    const instructions = String(
      (await loadCorpus(options.corpus, options.calls))[0]?.profile.agent.message ?? '',
    );
    ports.inference = openAiInference(net, key, {
      model: options.llmModel,
      instructions,
      webSearch: { enabled: true },
    });
    config.llm = `live ${options.llmModel}`;
  }
  return ports;
}

async function replay(
  call: CorpusCall,
  options: RunOptions,
  ports: LivePorts | undefined,
): Promise<ReplayResult> {
  const detector = await chooseDetector(
    options.detector ?? 'rules',
    call.profile.detector,
    options.detectorConfig,
  );
  const result =
    options.mode === 'transcript'
      ? await replayTranscript(call, {
          detector: detector.factory,
          ...(options.vad ? { vad: options.vad } : {}),
          ...(options.transcripts?.[call.name]
            ? { transcripts: options.transcripts[call.name] }
            : {}),
        })
      : await replayAudio(call, {
          detector: detector.factory,
          stt: ports!.stt(),
          ...(ports?.inference ? { inference: ports.inference } : {}),
          ...(options.log ? { log: options.log } : {}),
        });
  return { ...result, notes: [`detector ${detector.name}`, ...result.notes] };
}

export async function runEval(options: RunOptions): Promise<RunResult> {
  const calls = await loadCorpus(options.corpus, options.calls);
  const scores: CallScore[] = [];
  const transcripts: RunResult['transcripts'] = {};
  const config: Record<string, unknown> = {
    detector: options.mode === 'live' ? 'as recorded' : (options.detector ?? 'rules'),
    ...(options.detectorConfig ? { detectorConfig: options.detectorConfig } : {}),
    vad:
      options.mode === 'live'
        ? 'as recorded'
        : options.mode === 'audio'
          ? 'energy VAD on the audio'
          : (options.vad ?? 'trace'),
    llm: options.mode === 'live' ? 'as recorded' : 'recorded responder',
    ...options.config,
  };
  const net = options.mode === 'audio' ? createNodeNet() : undefined;
  try {
    const ports = net ? await livePorts(options, net, config) : undefined;
    for (const call of calls) {
      const notes = [...call.notes];
      let timeline: CallTimeline;
      let vad = call.vad;
      if (options.mode === 'live') timeline = liveTimeline(call);
      else if (!call.events || (options.mode === 'audio' && !call.audioPath)) {
        options.log?.(
          `${call.name}: skipped (a ${options.mode} replay needs ${call.events ? 'audio' : 'events'})`,
        );
        continue;
      } else {
        const result = await replay(call, options, ports);
        timeline = result.timeline;
        vad = result.vad;
        notes.push(...result.notes, `${result.stats.requests} LLM requests replayed`);
        if (result.stats.commits)
          notes.push(
            `${result.stats.modelledCommits} of ${result.stats.commits} STT commits answered by the model, not the live call`,
          );
        if (options.mode === 'audio')
          transcripts[call.name] = { stt: String(config.stt), transcripts: timeline.transcripts };
      }
      scores.push(
        scoreCall({
          call: call.name,
          ...(call.events?.callId ? { callId: call.events.callId } : {}),
          ...(call.label ? { label: call.label } : {}),
          mode: options.mode,
          notes,
          timeline,
          profile: call.profile,
          ...(call.gold ? { gold: call.gold } : {}),
          ...(vad ? { vad } : {}),
        }),
      );
      options.log?.(`${call.name}: scored`);
    }
  } finally {
    await net?.close();
  }
  return { card: scorecard(options.label, options.mode, config, scores), transcripts };
}
