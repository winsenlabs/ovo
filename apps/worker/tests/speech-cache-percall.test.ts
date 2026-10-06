import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MULAW_8K,
  PCM16_8K,
  type SynthesisInput,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { perCallLines } from '../src/speech-cache-percall.ts';
import {
  DEFAULT_SPEECH_CACHE_OPTIONS,
  speechCacheOptionsFromEnv,
} from '../src/speech-cache-env.ts';
import type { SpeechClipStore } from '../src/speech-cache-tiers.ts';
import { composeCacheOutput, fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

/** A provider whose first byte takes `firstByteMs` on the (fake) clock, like a live TTS round trip. */
class SlowTts extends RecordingTts {
  constructor(
    private readonly firstByteMs: number,
    private readonly hang = false,
  ) {
    super();
  }

  override async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.calls.push({ path: 'synthesize', text: input.text, sessionId: input.sessionId });
    await new Promise((resolve) => setTimeout(resolve, this.firstByteMs));
    if (this.hang) await new Promise(() => undefined);
    input.signal.throwIfAborted();
    for (let chunk = 0; chunk < 4; chunk++) yield new Uint8Array(160).fill(input.text.length);
  }
}

const VARIABLES = { name: 'Asha Rao', emi: 4850 };
const OPENING = 'Hi {{name}}, this is Monika from the bank.';
const SPOKEN = 'Hi Asha Rao, this is Monika from the bank.';

function greetFirstRelease(patch: Record<string, unknown> = {}) {
  return fixtureRelease({
    speechCache: { enabled: true },
    variables: {
      type: 'object',
      properties: { name: { type: 'string' }, emi: { type: 'number' } },
    },
    opening: { lines: [OPENING, 'I am calling about your loan.'] },
    voicemail: {
      detect: true,
      timeoutMs: 4000,
      action: 'message',
      message: 'Please call us back, {{name}}.',
    },
    idle: { timeoutMs: 6000, prompts: ['{{name}}, are you still there?'], finalLine: 'Goodbye.' },
    ...patch,
  });
}

function runtimeWith(tts: TextToSpeech, opened: { count: number } = { count: 0 }) {
  const runtime = new WorkerSpeechCacheRuntime();
  // What `startPrerender` attaches in production; the static pre-render loop is not under test.
  runtime.perCall.attachSpeech(async () => {
    opened.count += 1;
    return { tts, filters: [], close: async () => undefined };
  });
  return runtime;
}

function memoryStore() {
  const puts: string[] = [];
  const store: SpeechClipStore = {
    maxClipBytes: 1 << 20,
    get: async () => undefined,
    getMany: async () => new Map(),
    put: async (clip) => {
      puts.push(clip.key);
      return 'stored';
    },
    markRefs: async () => undefined,
  };
  return { store, puts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('per-call lines (TTS-10)', () => {
  it("renders a call's templated lines as its behaviour speaks them, opening first", () => {
    const lines = perCallLines(greetFirstRelease(), VARIABLES, {
      answeringMachine: true,
      maxLines: 16,
    });
    expect(lines).toEqual([
      { text: SPOKEN, source: 'opening', opening: true },
      { text: 'Please call us back, Asha Rao.', source: 'voicemail', opening: false },
      { text: 'Asha Rao, are you still there?', source: 'idle-prompt', opening: false },
    ]);
    // An inbound call never reaches a machine; a cap keeps the opening.
    expect(
      perCallLines(greetFirstRelease(), VARIABLES, { answeringMachine: false, maxLines: 1 }),
    ).toEqual([{ text: SPOKEN, source: 'opening', opening: true }]);
  });

  it('skips lines the call cannot fill, and everything when the cache is off', () => {
    const lines = perCallLines(greetFirstRelease(), {}, { answeringMachine: true, maxLines: 16 });
    expect(lines).toEqual([]);
    const off = greetFirstRelease({ speechCache: { enabled: false } });
    expect(perCallLines(off, VARIABLES, { answeringMachine: true, maxLines: 16 })).toEqual([]);
  });
});

describe('per-call clips in a live session (TTS-10)', () => {
  it('gives a greet-first outbound call its personal opening with no TTS wait', async () => {
    vi.useFakeTimers({ now: 0 });
    /**
     * Media connects at t=0 and the session takes `SETUP_MS` to compose (call record, telemetry,
     * graph) before the opening is spoken; the TTS first byte takes 800 ms. Returns the time from
     * media connect to the opening's first audio at the carrier.
     */
    const SETUP_MS = 300;
    const firstAudio = async (when: 'never' | 'admission' | 'ringing') => {
      const tts = new SlowTts(800);
      const runtime = runtimeWith(tts);
      const release = greetFirstRelease();
      const prepare = (claim: boolean) =>
        runtime.prepareCall({
          callKey: 'job-1',
          release,
          variables: VARIABLES,
          usage: () => undefined,
          answeringMachine: true,
          claim,
        });
      if (when === 'ringing') prepare(false);
      // The callee's phone rings for five seconds; then the media stream connects.
      await vi.advanceTimersByTimeAsync(5_000);
      const connectedAt = Date.now();
      const clips =
        when === 'ringing'
          ? runtime.perCall.claim('job-1')
          : when === 'admission'
            ? prepare(true)
            : undefined;
      await vi.advanceTimersByTimeAsync(SETUP_MS);
      const session = await composeCacheOutput({
        release,
        cache: runtime.cache,
        tts,
        perCall: clips ? { clips } : undefined,
      });
      const playing = session.play(SPOKEN);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await playing).toMatchObject({ state: 'completed' });
      const ms = session.sentAt[0]! - connectedAt;
      await session.dispose();
      runtime.perCall.release('job-1');
      await runtime.close();
      return ms;
    };
    const baseline = await firstAudio('never');
    const admission = await firstAudio('admission');
    const ringing = await firstAudio('ringing');
    // Measured on the fake clock. Before: setup, then the whole TTS round trip (1100 ms). At
    // admission the render overlaps setup (800 ms); started at dial hand-off it is ready when the
    // callee answers, so the opening plays as soon as the session is up (300 ms).
    expect({ baseline, admission, ringing }).toEqual({
      baseline: SETUP_MS + 800,
      admission: 800,
      ringing: SETUP_MS,
    });
  });

  it('never lets a personal clip reach the durable, pinned or L1 tiers, or the audit trail', async () => {
    const tts = new RecordingTts();
    const runtime = runtimeWith(tts);
    const durable = memoryStore();
    runtime.cache.attachDurable(durable.store);
    const audits: { kind: string; payload: Record<string, unknown> }[] = [];
    const release = greetFirstRelease({ clarification: 'Sorry?' });
    const clips = runtime.prepareCall({
      callKey: 'job-2',
      release,
      variables: VARIABLES,
      usage: () => undefined,
      answeringMachine: true,
    })!;
    await vi.waitFor(() => expect(clips.get(SPOKEN)?.ready).toBe(true));
    const session = await composeCacheOutput({
      release,
      cache: runtime.cache,
      tts,
      perCall: { clips: runtime.perCall.claim('job-2')! },
      observer: { audit: (kind, payload) => audits.push({ kind, payload }) },
    });
    await session.play(SPOKEN);
    await session.play('Asha Rao, are you still there?');
    await session.play('Sorry?');
    await vi.waitFor(() => expect(durable.puts).toHaveLength(1));
    await session.dispose();
    // Only the fixed line went to the shared tiers; every personal line stayed with the call.
    expect(runtime.cache.pinned.stats.entries).toBe(1);
    expect(runtime.cache.stats.entries).toBe(1);
    expect(audits.filter((a) => a.kind === 'speech.cache').map((a) => a.payload.source)).toEqual([
      'template',
      'template',
      'miss',
    ]);
    expect(JSON.stringify(audits)).not.toContain('Asha');
    // Session end drops the audio.
    expect(clips.discarded).toBe(true);
    expect(clips.get(SPOKEN)).toBeUndefined();
    runtime.perCall.release('job-2');
    expect(runtime.perCall.size).toBe(0);
    // Each personal line was rendered exactly once for the call.
    expect(tts.calls.filter((call) => call.text.includes('Asha'))).toHaveLength(3);
    await runtime.close();
  });

  it('speaks the line live when the early render fails or stalls past its budget', async () => {
    vi.useFakeTimers({ now: 0 });
    const stalled = new SlowTts(100, true);
    const runtime = runtimeWith(stalled);
    const release = greetFirstRelease();
    const clips = runtime.prepareCall({
      callKey: 'job-3',
      release,
      variables: VARIABLES,
      usage: () => undefined,
      answeringMachine: false,
      claim: true,
    })!;
    const live = new SlowTts(300);
    const audits: Record<string, unknown>[] = [];
    const session = await composeCacheOutput({
      release,
      cache: runtime.cache,
      tts: live,
      perCall: { clips },
      observer: { audit: (_kind, payload) => audits.push(payload) },
    });
    const playing = session.play(SPOKEN);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await playing).toMatchObject({ state: 'completed' });
    // 1.5 s budget on the stalled render, then a 300 ms live render.
    expect(session.sentAt[0]).toBe(1_800);
    expect(audits[0]).toMatchObject({ source: 'bypass' });
    await session.dispose();
    await runtime.close();
  });

  it('keeps a personal render a barge-in cut off, so a repeat in the same call reuses it', async () => {
    vi.useFakeTimers({ now: 0 });
    const tts = new SlowTts(500);
    const runtime = runtimeWith(tts, { count: 0 });
    const release = greetFirstRelease();
    const clips = runtime.prepareCall({
      callKey: 'job-4',
      release,
      variables: VARIABLES,
      usage: () => undefined,
      answeringMachine: false,
      claim: true,
    })!;
    const session = await composeCacheOutput({
      release,
      cache: runtime.cache,
      tts,
      perCall: { clips },
    });
    const bargeIn = new AbortController();
    const first = session.play(SPOKEN, 'response', bargeIn.signal);
    await vi.advanceTimersByTimeAsync(100);
    bargeIn.abort(new DOMException('caller spoke', 'AbortError'));
    expect(await first).toMatchObject({ state: 'interrupted' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clips.get(SPOKEN)?.ready).toBe(true);
    const repeat = session.play(SPOKEN);
    await vi.advanceTimersByTimeAsync(100);
    expect(await repeat).toMatchObject({ state: 'completed' });
    expect(tts.calls.filter((call) => call.text === SPOKEN)).toHaveLength(1);
    await session.dispose();
    await runtime.close();
  });

  it('drops clips no session claims, and ignores a set rendered for another format', async () => {
    vi.useFakeTimers({ now: 0 });
    const tts = new RecordingTts();
    const runtime = runtimeWith(tts);
    const release = greetFirstRelease();
    const clips = runtime.prepareCall({
      callKey: 'job-5',
      release,
      variables: VARIABLES,
      usage: () => undefined,
      answeringMachine: true,
    })!;
    await vi.advanceTimersByTimeAsync(10);
    expect(clips.get(SPOKEN)?.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(runtime.perCall.options.unclaimedTtlMs);
    expect(clips.discarded).toBe(true);
    expect(runtime.perCall.size).toBe(0);
    const pcm = runtime.prepareCall({
      callKey: 'job-6',
      release,
      variables: VARIABLES,
      usage: () => undefined,
      answeringMachine: false,
      format: PCM16_8K,
      claim: true,
    })!;
    expect(pcm.format).toEqual(PCM16_8K);
    const session = await composeCacheOutput({
      release,
      cache: runtime.cache,
      tts,
      perCall: { clips: pcm },
    });
    await vi.advanceTimersByTimeAsync(10);
    await session.play(SPOKEN);
    await session.dispose();
    // The 8 kHz PCM render is never played on this mu-law session: the line is spoken live.
    expect(MULAW_8K).not.toEqual(PCM16_8K);
    expect(tts.calls.filter((call) => call.text === SPOKEN).map((call) => call.sessionId)).toEqual([
      'percall:job-5',
      'percall:job-6',
      'session-1',
    ]);
    runtime.perCall.release('job-6');
    await runtime.close();
  });

  it('prepares a dialled job from its payload, metering renders to that job', async () => {
    const tts = new RecordingTts();
    const runtime = runtimeWith(tts);
    const release = greetFirstRelease();
    const metered: string[] = [];
    const jobs = new Map([
      [
        'job-7',
        { workspaceId: 'workspace-a', payload: { releaseId: 'release-1', variables: VARIABLES } },
      ],
      ['job-8', { workspaceId: 'workspace-a', payload: { releaseId: 'missing' } }],
    ]);
    const deps = {
      jobs: { get: async (id: string) => jobs.get(id) },
      releases: {
        getRelease: async (_: string, id: string) => (id === release.id ? release : undefined),
      },
      usage: (jobId: string) => () => void metered.push(jobId),
    };
    const clips = await runtime.prepareJob('job-7', deps);
    await vi.waitFor(() => expect(clips?.get(SPOKEN)?.ready).toBe(true));
    // Outbound: the voicemail message is rendered with the opening, before anyone answers.
    expect(clips?.get('Please call us back, Asha Rao.')).toBeDefined();
    expect(metered.every((jobId) => jobId === 'job-7') && metered.length > 0).toBe(true);
    expect(await runtime.prepareJob('job-8', deps)).toBeUndefined();
    expect(await runtime.prepareJob('job-9', deps)).toBeUndefined();
    await runtime.close();
    expect(clips?.discarded).toBe(true);
  });

  it('reads its limits from the environment and rejects invalid values', () => {
    expect(speechCacheOptionsFromEnv({}).perCall).toEqual(DEFAULT_SPEECH_CACHE_OPTIONS.perCall);
    expect(
      speechCacheOptionsFromEnv({
        OVO_SPEECH_PERCALL_ENABLED: 'false',
        OVO_SPEECH_PERCALL_SCOPE: 'opening',
        OVO_SPEECH_PERCALL_MAX_LINES: '4',
      }).perCall,
    ).toMatchObject({ enabled: false, scope: 'opening', maxLines: 4 });
    expect(() => speechCacheOptionsFromEnv({ OVO_SPEECH_PERCALL_SCOPE: 'some' })).toThrow();
    expect(() => speechCacheOptionsFromEnv({ OVO_SPEECH_PERCALL_ENABLED: 'yes' })).toThrow();
    expect(() => speechCacheOptionsFromEnv({ OVO_SPEECH_PERCALL_MAX_LINES: '0' })).toThrow();
    const off = new WorkerSpeechCacheRuntime(
      {},
      speechCacheOptionsFromEnv({ OVO_SPEECH_PERCALL_ENABLED: 'false' }),
    );
    expect(
      off.prepareCall({
        callKey: 'job-10',
        release: greetFirstRelease(),
        variables: VARIABLES,
        usage: () => undefined,
        answeringMachine: false,
      }),
    ).toBeUndefined();
  });
});
