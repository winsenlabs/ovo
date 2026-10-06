# Speech cache

Pre-rendered audio for an agent's fixed lines, so a scripted turn plays in milliseconds instead of
waiting 0.6-1.6 s for live TTS.

## Opt-in

The cache is off unless the agent turns it on: `speechCache: { enabled: true }` in the agent config
(the default is unchanged: no `speechCache` block means every line is synthesized live). With it on:

- every fixed line of the release is cacheable whatever speech kind the engine gives it: greeting
  (`message`), greet-first opening lines, voicemail message, processing phrases, clarification,
  uncertainty, FAQ answers, decision `say` lines, script prompts and the turn detector's idle
  prompts (`staticSpeechInventory`);
- lines with `{{variables}}` are per-call and never pre-rendered or stored durably;
- model output is always synthesized live, through the provider's incremental path when it has one.

Lines are matched on the text the speaker actually sends, after the release's text filters
(markdown, URL, Indian verbalisation...). Pre-render and live lookup both normalize through the
same chain, so a configured `**₹4,850**` and the spoken "four thousand eight hundred and fifty
rupees" share one clip.

## Tiers

Lookup order in the worker: pinned (memory, for the release's lifetime, no TTL) → L1 (memory, TTL)
→ durable (PostgreSQL `ovo_speech_clips`) → live render. A live render of a fixed line is detached
from the caller: a barge-in stops playback, not the render, and the clip is kept for the next call.

The durable tier stores audio bytes only (never text), keyed by the full cache identity digest:
workspace, provider, model, voice, locale, codec, sample rate, provider revision and a hash of every
audio-affecting binding field (TTS-13). A release whose TTS binding is not pinned is never stored.

## Pre-render

Publishing a release that opts in queues it in `ovo_speech_prerender_jobs`; one worker claims it and
renders only the lines the durable tier is missing. Workers also warm routed releases at start and a
release on its first call. Usage is metered to the workspace under ledger session
`prerender:<releaseId>`, source event `speech.prerender`. Progress is at
`GET /v1/agents/:agentId/releases/:releaseId/speech-clips`.

## Environment (worker)

| Variable                               | Default | Meaning                                   |
| -------------------------------------- | ------- | ----------------------------------------- |
| `OVO_SPEECH_CACHE_TTL_MS`              | 300000  | L1 entry lifetime                         |
| `OVO_SPEECH_CACHE_MAX_ENTRIES`         | 256     | L1 entries                                |
| `OVO_SPEECH_CACHE_MAX_BYTES`           | 32 MiB  | L1 bytes                                  |
| `OVO_SPEECH_CACHE_MAX_ENTRY_BYTES`     | 2 MiB   | L1 bytes per entry                        |
| `OVO_SPEECH_CACHE_MAX_PENDING`         | 16      | L1 loads in flight                        |
| `OVO_SPEECH_CLIPS_MAX_BYTES`           | 256 MiB | pinned tier budget                        |
| `OVO_SPEECH_CLIP_MAX_BYTES`            | 2 MiB   | one clip, live or durable                 |
| `OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES` | 512 MiB | durable bytes per workspace               |
| `OVO_SPEECH_CLIPS_RETENTION_DAYS`      | 30      | GC of unreferenced, unused durable clips  |
| `OVO_SPEECH_PRERENDER_ENABLED`         | true    | `false` turns the pre-render worker off   |
| `OVO_SPEECH_PRERENDER_CONCURRENCY`     | 4       | renders in flight per worker              |
| `OVO_SPEECH_PRERENDER_POLL_MS`         | 5000    | how often an idle worker checks the queue |

Invalid values stop the worker at startup.
