# Mandatory stack research and architecture decisions

Execute [the detailed upstream assignment](09-upstream-research-assignment.md) as part of this research. Reading landing pages is insufficient; source maps, comparative spikes and reuse decisions are mandatory.

## 1. Research discipline

The product direction is set; the exact stack needs verification. Research is an implementation task with deliverables and an exit gate, not endless browsing. Use official documentation, source repositories and reproducible experiments. For every choice record date, version/commit, license, maintenance signals, supported runtime, capability gaps, test results, migration cost, dependencies and an explicit recommendation.

Do not infer Python/Node feature parity, low latency from language choice, Fargate compatibility from “Docker supported,” or safe retries from a timeout. Do not adopt a vendor's latency claim as OVO's benchmark.

## 2. Research tasks

| ID | Question | Investigation and required output | Suggested effort |
|---|---|---|---|
| R01 | How should TypeScript execute the voice loop? | Inspect Pipecat frames, priority queues, cancellation, context, tool outcomes and cleanup. Inspect LiveKit Agents JS. Compare narrow custom runtime versus adapting existing TS engine. Produce execution-semantics ADR and failing/passing race fixtures. | 3–5 engineer-days |
| R02 | How do plugins compose? | Audit and directly reuse DeepSeek Harness/Cordis composition and lifecycle source. Select pinned dependency reuse versus a maintained source extraction; do not replace it with an independent registry. Verify scope, cleanup, validation, UI schema generation and compatibility. Build a two-provider swap spike. | 1–3 days |
| R03 | Which carrier and transport work in target market? | Compare available Twilio/Telnyx/Plivo/Exotel or selected carrier; verify bidirectional streaming, codecs, clear/mark semantics, transfer, inbound/outbound, callback signing, account onboarding and regional limits. Record provider capability matrix; do not purchase accounts without authorization. | 2–4 days plus external lead time |
| R04 | Does media deployment fit Fargate and EC2? | Prove WebSocket routing to owning worker, long-lived connections, drain/reconnect behavior; if using LiveKit, test SIP/RTP/public addressing/TURN/recording explicitly. Deliver network diagram and measured topology. | 2–4 days |
| R05 | Which STT/TTS/LLM combination? | Benchmark first audio, endpointing, interruption, names/amounts, selected Indian language/code-switching and regional availability. Verify streaming APIs, quotas, actual price units and cancellation. | 2–4 days |
| R06 | Which data/analytics layout? | Compare DynamoDB event/projection design with relational alternatives for query needs. Keep S3 artifacts and SQS jobs. Benchmark call search and percentiles without unbounded scans. Decide source of truth, indexes and aggregation. | 1–3 days |
| R07 | How are agent secrets managed? | Verify Secrets Manager/KMS, write-only UI, validation, scoped worker retrieval, rotation/deletion, IAM and redaction. Produce threat model and lifecycle test. | 1–2 days |
| R08 | Which frontend stack and authoring UX? | Validate accessible forms, script graph editing, virtualized transcript, charts/audio sync and live updates. Choose minimal libraries; evaluate usable graph/table fallback. | 1–3 days |
| R09 | How do we test voice reliably? | Build virtual clock, fixture transport, controlled interruption injection and benchmark harness; compare identical providers and audio across reference/prototype. | 2–4 days |

Research tasks overlap with the first engineering work packages; do not double-count these days in the project estimate. Timeboxes guide scope, not permission to skip unresolved blockers.

## 3. Stack decision matrix to fill

| Area | Starting candidate | Required alternative/control | Selection evidence |
|---|---|---|---|
| Language/runtime | TypeScript on Node LTS | Pipecat Python reference only | Correctness, event-loop lag, startup, memory, developer burden |
| Voice engine | Focused OVO pipeline | LiveKit Agents JS | Same scenario/provider tests; transport coupling; required custom work |
| Plugin host | Actual DeepSeek Harness/Cordis foundation | Pinned upstream modules versus traceable source extraction | Import map, lifecycle tests, license notices and upgrade strategy |
| Backend | NestJS | Fastify with typed contracts | Streaming/control separation; implementation complexity |
| Frontend | Next.js/React | Existing repo choice if any | Browser test results; ecosystem; deployability |
| Schema | JSON Schema plus typed generator/validator | Zod with verified schema export | One source for UI/API/runtime; custom refinements represented |
| Inference | Direct provider adapter | Vercel AI SDK adapter | Streaming tools, cancellation, usage fidelity; no duplicate loop |
| Storage | DynamoDB + S3 | PostgreSQL + S3 | Lease/event transaction semantics; query/retention needs |
| Metrics | OpenTelemetry + CloudWatch/projections | ClickHouse-backed analytics | Query latency/cost at target volume; histogram correctness |
| Jobs | SQS + durable outbox | Local test adapter only | Deduplication, lease, retry and reconciliation |

## 4. Proof-of-concept gate

Use one reference scenario: caller requests a check; acknowledgment starts; tool runs; caller interrupts; result arrives; response accounts for the correction. Add announcement and no-LLM FAQ paths so the prototype does not assume an LLM is universal.

Prove cancellation, ordered playback, result preservation, no duplicate side effects, bounded queues, context accuracy, resource cleanup and frontend timeline evidence. Test on a real owned number after sandbox correctness. Compare identical models, voice, language, carrier and input corpus; publish complete failed/timeout cases. A faster median with stale speech or incorrect actions fails.

Select the TypeScript implementation that meets these invariants with the least long-term maintenance. If a custom engine is needed, document why existing TS options do not satisfy requirements. Do not silently switch production to Python, make LiveKit mandatory, or remove deployment profiles. Escalate only an actual conflict with fixed requirements.

## 5. Required research outputs

Create `docs/research/stack-evaluation.md`, `provider-capabilities.md`, `voice-benchmark.md`, `deployment-feasibility.md`, and `docs/decisions/0001-runtime.md` onward. Include reproducible commands/scripts, environment, raw results and source commit hashes. Provide accepted/rejected decisions with consequences. Current documents are instructions, not completed experiments.

## 6. Grounding sources

The following are starting points inspected during planning; recheck versions at implementation time.

- [Pipecat pipeline](https://docs.pipecat.ai/pipecat/learn/pipeline): modular frames/processors and ordered processing lanes.
- [Pipecat processor source](https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/processors/frame_processor.py): priority scheduling and interruption handling.
- [Pipecat frames source](https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/frames/frames.py): cancellation semantics and preserved function results.
- [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions): playback/context coordination.
- [Pipecat telephony](https://docs.pipecat.ai/pipecat/telephony/overview): direct streaming options; exact call-control capability depends on integration.
- [LiveKit Agents JS](https://github.com/livekit/agents-js): existing Node voice-agent implementation; verify selected providers and APIs directly.
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md): plugin services, scopes and durable events.
- [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/): media networking considerations.
- [Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html): task networking constraints.
- [Secrets Manager practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html): credential management reference.

Preserve upstream notices for any reused code. Select OVO's project license explicitly; do not assume upstream license compatibility without review.
