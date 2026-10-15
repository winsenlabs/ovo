/**
 * Rebuilds corpus/callN.json from the raw call exports (run on the mini, where they live):
 *   tsx packages/eval/src/turns/corpus-build.ts <dir with call5-events.json, call6-events.jsonl,
 *     call7-events.jsonl, call8-events.jsonl>
 * call5-events.json is the c5ev.json export of call 10d5ef30.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCall4, buildCompact, type CompactCall } from './corpus.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: corpus-build.ts <raw export dir>');
const raw = (file: string) => readFileSync(join(dir, file), 'utf8');
const calls: Record<string, CompactCall> = {
  call4: buildCall4(),
  call5: buildCompact(
    '10d5ef30',
    'call 5',
    'Maya call 10d5ef30 (2026-10-12): engine events',
    raw('call5-events.json'),
  ),
  call6: buildCompact(
    '4f1a919d',
    'call 6',
    'Maya call 4f1a919d (2026-10-13): engine events',
    raw('call6-events.jsonl'),
  ),
  call7: buildCompact(
    '8cb76efc',
    'call 7',
    'Maya call 8cb76efc (2026-10-14 02:54 UTC, Wave 10): engine events',
    raw('call7-events.jsonl'),
    'call7-caller.wav',
  ),
  call8: buildCompact(
    'eb509d62',
    'call 8',
    'Maya call eb509d62 (2026-10-14 17:58 UTC, Wave 12): engine events',
    raw('call8-events.jsonl'),
    'call8-caller.wav',
  ),
};
for (const [name, call] of Object.entries(calls)) {
  const path = new URL(`./corpus/${name}.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(call, null, 1)}\n`);
  console.log(
    name,
    call.transcripts.length,
    'transcripts',
    call.agent.length,
    'agent lines',
    call.live.length,
    'live turns',
  );
}
