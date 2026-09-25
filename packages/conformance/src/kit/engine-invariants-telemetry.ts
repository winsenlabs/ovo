import type { EngineEvent, StageKey, UsageMeter } from '@winsendotai/ovo-contracts';
import type { EngineHarness } from './engine-harness.ts';

const STAGE_KEYS = new Set<StageKey>([
  'vad_stop_wait',
  'stt_finalize',
  'turn_decision',
  'behavior_first_segment',
  'llm_ttfb',
  'text_aggregation',
  'tts_ttfb',
  'carrier_first_audio',
  'playout_ack',
  'bargein_latency',
]);

const key = (meter: UsageMeter) =>
  `${meter.provider}:${meter.operation}:${meter.requestId}:${meter.unit}`;

/**
 * Every meter the speech plugins emitted reaches the host's UsageSink (#F12). The harness used to
 * collect `usage` and never read it, so an engine that dropped every meter — all of the speech
 * billing for the call — passed the kit.
 */
export function usageDeliveryFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  const delivered = new Set(harness.usage.map(key));
  const expected: UsageMeter[] = [
    ...harness.stt.sessions.flatMap((session) => [...session.usage]),
    ...harness.tts.usage,
  ];
  for (const meter of expected)
    if (!delivered.has(key(meter)))
      failures.push(
        `the ${meter.operation} meter ${meter.unit}=${meter.quantity} (${meter.requestId}) never reached the engine's UsageSink`,
      );
  if (harness.tts.texts.length > 0 && !harness.usage.some((m) => m.operation === 'tts'))
    failures.push('the engine spoke but reported no tts usage');
  if (harness.stt.sessions.length > 0 && !harness.usage.some((m) => m.operation === 'stt'))
    failures.push('the engine opened an STT session but reported no stt usage');
  for (const meter of harness.usage) {
    if (!meter.requestId) failures.push(`usage ${meter.unit} reached the host without a requestId`);
    if (!Number.isFinite(Number(meter.quantity)))
      failures.push(`usage ${meter.unit} has a non-numeric quantity ${meter.quantity}`);
  }
  return failures;
}

const timings = (harness: EngineHarness) =>
  harness.events().flatMap((event) => (event.type === 'timing' ? [event] : []));

/** `timing` events were an untested surface (#F18): telemetry reads them for every stage. */
export function timingFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  const segments = new Set(
    harness
      .events()
      .flatMap((event) => (event.type === 'speech' ? [event.evidence.segmentId] : [])),
  );
  for (const event of timings(harness)) {
    if (!STAGE_KEYS.has(event.key) && !/^tool:.+/.test(event.key))
      failures.push(`timing event has an unknown StageKey '${event.key}'`);
    if (!Number.isFinite(event.atMs) || event.atMs < 0)
      failures.push(`timing '${event.key}' has atMs ${event.atMs}`);
    if (event.ms !== undefined && (!Number.isFinite(event.ms) || event.ms < 0))
      failures.push(`timing '${event.key}' has ms ${event.ms}`);
    if (event.segmentId && !segments.has(event.segmentId))
      failures.push(`timing '${event.key}' names segment ${event.segmentId}, which never existed`);
  }
  if (harness.tts.texts.length > 0 && timings(harness).length === 0)
    failures.push('the engine spoke but emitted no timing events for any stage');
  return failures;
}

/** The engine's declared EngineCapabilities, checked for shape and against what it did (#F18). */
export function capabilityFailures(
  harness: EngineHarness,
  events: readonly EngineEvent[],
): string[] {
  const caps = harness.underTest.capabilities;
  if (!caps)
    return [
      'the engine did not declare EngineCapabilities: return them as `capabilities` from the factory',
    ];
  const failures: string[] = [];
  const known = ['provider', 'vad-timeout', 'smart-turn', 'stt'];
  if (!Array.isArray(caps.turnDetection) || caps.turnDetection.length === 0)
    failures.push('capabilities.turnDetection must list at least one strategy');
  else
    for (const strategy of caps.turnDetection)
      if (!known.includes(strategy))
        failures.push(`capabilities.turnDetection has an unknown strategy '${strategy}'`);
  for (const flag of ['bargeIn', 'dtmf', 'confirmedPlayback', 'consumesTurnDetector'] as const)
    if (typeof caps[flag] !== 'boolean')
      failures.push(`capabilities.${flag} must be a boolean, got ${typeof caps[flag]}`);
  if (caps.ownsProviders !== false)
    failures.push('capabilities.ownsProviders must be false: engines never resolve providers');
  if (!Array.isArray(caps.formats) || caps.formats.length === 0)
    failures.push('capabilities.formats must list the carrier formats the engine accepts');
  else
    for (const format of caps.formats)
      if (!format?.encoding || !format?.sampleRate)
        failures.push(`capabilities.formats has an incomplete entry ${JSON.stringify(format)}`);
  if (caps.dtmf === false && events.some((e) => e.type === 'user.turn' && e.input === 'dtmf'))
    failures.push('capabilities.dtmf is false but the engine dispatched a DTMF turn');
  if (caps.bargeIn === false && events.some((e) => e.type === 'interrupt'))
    failures.push('capabilities.bargeIn is false but the engine emitted an interrupt');
  return failures;
}
