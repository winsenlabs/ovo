# Routing points, agent pools, the conversational router and in-call transfer (Waves 15-16, R1-R2)

**State:** built and tested offline (unit, PostgreSQL, the live-path e2e harness on loopback). Ships
dark: with `OVO_ROUTING_ENABLED=false` (the default) no call is routed, and a number that is
already bound to a routing release is answered by that release's default agent. No deploy, no VM
change. Every variable: [environment reference](../env-reference.md#routing-points-agent-pools-and-in-call-transfer-waves-15-16).

## What it does

A call no longer has to go straight to one agent. A number can be bound to a **routing point**:

1. A **router** answers first. It greets the caller, works out their language and intent from what
   they say (a keypad press is an optional rule, never a numbered menu by default), asks a
   clarifying question when unsure, and decides.
2. The decision walks a **routing tree**: nested nodes, each with its own **engines** (tried in
   order) and its own **fallback chain**.
3. The tree ends in a **target**: usually an **agent pool**, whose members are agent releases that
   declare the languages, products and skills they support, a priority, opening hours and a
   capacity. The best eligible member with room is claimed.
4. The router hands the call to that agent **on the same carrier leg and media stream**: same
   recording, same cost reservation, same call record. Only the voice engine graph is swapped.

R1 hands off once, at the end of routing. Wave 16 (R2) adds [in-call agent transfer](#in-call-agent-transfer-wave-16-r2)
on the same seam, behind its own flag; human queues (R3) and the routing designer (R4) build on it
too; see [what later waves add](#what-later-waves-add).

```
caller ─ carrier ─ media-gateway ──(admission: number → routing release → router release)── ovo_jobs
                                                                                      │
worker  WorkerMediaRuntime ── RoutedSession                                           │
          │                     ├─ call scope: call record, telemetry, recording, events, cost (1 per call)
          │                     ├─ segment 0: router graph (router release voice + router behaviour)
          │                     │      router behaviour ⇄ RoutingHost (external webhook, member claims)
          │                     │      router behaviour ⇄ SegmentHandoffPort (prepare / commit)
          │                     └─ segment 1: the chosen agent's graph, same media link
          └─ one media link per call, leased per segment
```

## Concepts

| Concept         | What it is                                                                                                                                                                                                                                                                | Where                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Agent pool      | Named set of members. A member is an agent (pinned release, or `latest` resolved at publish) with `languages`, `products`, `skills`, `priority` (0-100), `hours` and `capacity` (concurrent calls). `languageFallback` is tried when nobody speaks the caller's language. | `RoutingPoolDefinition`, table `ovo_routing_pools`     |
| Routing point   | The editable **draft** of a tree: the router agent, the default target, languages, greeting and the nodes. Versioned (`draftVersion`).                                                                                                                                    | `RoutingPointDraft`, table `ovo_routing_points`        |
| Routing release | An immutable, numbered (1, 2, 3...) freeze of a point: every agent reference pinned, every pool copied in, all release ids listed, sha256 digest. A database trigger refuses updates and deletes.                                                                         | `RoutingReleaseSnapshot`, table `ovo_routing_releases` |
| Router          | An ordinary agent release (the "front desk") whose engine, carrier, STT, TTS, LLM, decision slot, language, cost policy and recording are used; its behaviour is replaced by the router behaviour. Its own prompt, opening and tools do not run while routing.            | `packages/plugin-router`                               |
| Default target  | A direct agent: the last resort of every fallback chain and the kill-switch target.                                                                                                                                                                                       | `RoutingPointDraft.defaultTarget`                      |
| Member claim    | One active claim per call against a (pool, member), counted against the member's capacity until released or expired.                                                                                                                                                      | table `ovo_routing_member_claims`                      |

A number pins a routing **release** exactly as it pins an agent release today:
`ovo_ops_inbound_routes.routing_release_id` (a CHECK keeps exactly one of `release_id` and
`routing_release_id`). Publishing a new release changes nothing until the number is re-PUT.

### Engines (per node, tried in order; the first match at or above its threshold wins)

| Kind       | Decides on                                                                                                                                                                                                        | Notes                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules`    | `dtmf` digits, `caller-id` E.164 prefixes, `time` (opening hours), call `variable`, `keywords`, exact `phrases`, `script` (the reply's writing system: Devanagari, Tamil...). Every matcher of a rule must match. | Confidence 1. No regex. `caller-id`, `time` and `variable` need no caller turn, so a node made only of them decides on the opening turn.                                                                          |
| `decision` | The router release's decision slot (Jev today): one `choice` question whose criteria are the branch descriptions.                                                                                                 | `threshold` default 0.7, `timeoutMs` default 800. Absent slot: `disabled`, next engine.                                                                                                                           |
| `llm`      | The router release's LLM, forced to call one reserved tool `ovo_route` with `{ branch, confidence, language?, clarify? }`.                                                                                        | Branch and language are enums of the configured keys, re-checked in code. A text reply is `no_match`. Confidence is the model's own and uncalibrated.                                                             |
| `external` | A signed HTTPS webhook (`ovo.route-decision/1`) answering `{ branch, confidence, slots }`.                                                                                                                        | Off unless `OVO_ROUTING_EXTERNAL_ENABLED=true`. HTTPS, public addresses, DNS-pinned, no redirects, at most 16 KiB, one attempt within `timeoutMs` (default 1500). Clef and any CRM decision service plug in here. |

### Fallback chain (per node; resumes where it left off; must end in `default`, `callback` or `end`)

`reask` (up to `times`, with its own line or the node's `ask`) → `default` (a pool or agent, or the
release default target) → `human` (R3; in R1 skipped and recorded) → `callback` (a durable callback
to the agent that promised it) → `end` (a polite line, then hang up). If every step fails, the
release default target is tried once more as `release_default`; if even that cannot start, the
router speaks the built-in end line.

## Operator walkthrough (API)

Routing is API-first in R1; the designer is R4. Turn it on for the API and the gateway first
(`OVO_ROUTING_ENABLED=true` in `infra/compose/.env`, then redeploy). `GET /v1/routing/status`
reports `{ enabled, externalEnabled }`. The examples use a signed-in session cookie, as the other
runbooks do.

**1. Create a pool** (editor). The name is unique per workspace, case-insensitively.

```bash
curl -sS -X POST "$OVO_API/v1/routing/pools" -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"definition":{"name":"Sales","languageFallback":["en"],"members":[
        {"id":"sales-en","agent":{"agentId":"'"$SALES_EN"'","release":{"kind":"latest"}},"languages":["en"],"products":["cards","loans"],"capacity":20},
        {"id":"sales-hi","agent":{"agentId":"'"$SALES_HI"'","release":{"kind":"latest"}},"languages":["hi"],"products":["cards","loans"],"capacity":20,
         "hours":{"timezone":"Asia/Kolkata","weekly":{"mon":[{"start":"09:00","end":"21:00"}]}}}]}}'
# 201 { "id": "<pool id>", "version": 1, ... } with an ETag; PUT and DELETE need If-Match.
```

**2. Create a routing point** with its draft (the [worked example](#worked-example) below).
Structural problems come back as `422 { issues }`, each `{ code, severity, path, message }`.

```bash
curl -sS -X POST "$OVO_API/v1/routing/points" -H 'content-type: application/json' -b "$COOKIE" \
  -d @main-line.json            # { "draft": { ...RoutingPointDraft... } }
curl -sS -X POST "$OVO_API/v1/routing/points/$POINT/validate" -b "$COOKIE"   # full publish checks, writes nothing
```

**3. Publish** a release. `latest` references are resolved and pinned now; publish refuses
blockers (a missing release, a router without STT, an unpriced member meter...).

```bash
curl -sS -X POST "$OVO_API/v1/routing/points/$POINT/releases" -H 'content-type: application/json' \
  -b "$COOKIE" -d '{"expectedDraftVersion":1}'
# 201 { "id": "<routing release id>", "version": 1, "digest": "…", "snapshot": { … } }
```

**4. Bind the number** (admin). Give exactly one of `releaseId` and `routingReleaseId`; switching
between them is one optimistic PUT. `variables` are checked against the **router** release.

```bash
curl -sS -X PUT "$OVO_API/v1/operations/inbound/routes/%2B918069450000" -H 'content-type: application/json' \
  -b "$COOKIE" -d '{"expectedVersion":3,"routingReleaseId":"'"$ROUTING_RELEASE"'","variables":{},
  "carrierPluginId":"@winsendotai/ovo-carrier-twilio","carrierBindingId":"'"$BINDING"'"}'
# The route now shows "releaseId": null, "routingReleaseId": "…", "routing": { "pointId", "pointName", "version" }.
```

**5. Watch a call.** `GET /v1/calls/:callId/outcome` returns `summary.route` (path, target, agent,
pool, member, language, degraded, segments) and the `route.node`, `route.fallback`,
`route.decision` and `route.segment` events in order. The same events appear in the call
inspector's Events tab.

**Roll back** by re-PUTting the number with an earlier routing release id, or with a direct
`releaseId`. **Kill switch:** set `OVO_ROUTING_ENABLED=false` on the gateway; every routed number
is answered by its release's default agent straight away (admission detail `routingDisabled`).

## Worked example

Ten sales agents, one per language, plus a support pool. Pool "Sales" holds `sales-en`, `sales-hi`,
`sales-ta`... each `languages: ['<one>']`, `products: ['cards', 'loans']`, `languageFallback: ['en']`.

```json
{
  "name": "Main line",
  "router": { "agentId": "<front-desk>", "release": { "kind": "latest" } },
  "defaultTarget": { "agentId": "<sales-en>", "release": { "kind": "latest" } },
  "language": {
    "default": "en",
    "allowed": ["en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "pa"]
  },
  "greeting": {
    "en": "Welcome to Acme. You can speak in your own language. How can I help you today?"
  },
  "root": "intent",
  "nodes": [
    {
      "id": "intent",
      "sets": "intent",
      "ask": { "en": "Are you calling to buy something new, or about an existing account?" },
      "engines": [
        {
          "kind": "rules",
          "rules": [
            { "branch": "sales", "when": [{ "kind": "dtmf", "digits": "1" }] },
            { "branch": "support", "when": [{ "kind": "dtmf", "digits": "2" }] }
          ]
        },
        {
          "kind": "llm",
          "instructions": "Decide why the caller is calling.",
          "detectLanguage": true
        }
      ],
      "branches": [
        {
          "key": "sales",
          "description": "Wants to buy, asks about prices, plans, new cards or loans",
          "target": { "kind": "pool", "poolId": "<sales-pool>", "language": "caller" }
        },
        {
          "key": "support",
          "description": "Has a problem with an existing account, order or payment",
          "target": { "kind": "pool", "poolId": "<support-pool>", "language": "caller" }
        }
      ],
      "fallback": [
        { "kind": "reask", "times": 1 },
        { "kind": "default" },
        {
          "kind": "end",
          "line": {
            "en": "Sorry, I could not connect your call. Please call again later. Goodbye."
          }
        }
      ]
    }
  ]
}
```

A Hindi caller says "mujhe naya credit card chahiye". The keypad rule does not match
(`route.node rules no_match`); the classifier answers `{ branch: sales, confidence: 0.91,
language: hi }` (`route.node llm matched`). The router filters Sales to members that speak Hindi,
are enabled and open now, groups them by priority, and claims the least-loaded one with room
(`sales-hi`). It composes `sales-hi`'s graph and pre-connects its STT while it says the connecting
line in Hindi, then swaps segments on the same leg (`route.decision`, `route.segment 1`). The agent
greets the caller and can read `{{ovo_route_intent}}` and `{{ovo_route_language}}` if its variable
schema declares them.

Nested routing (product, then language, then pool) is the same shape: a `product` node whose
branches lead (`next`) to per-product nodes, or one pool target with `products: { context: 'product' }`.

## In-call agent transfer (Wave 16, R2)

**State:** built and tested offline; ships dark behind `OVO_ROUTING_TRANSFER_ENABLED=false` (and
routing itself behind `OVO_ROUTING_ENABLED`). With the flag off a routed call runs byte for byte as
R1, and a number bound directly to an agent release never changes, flag or no flag: transfers exist
only on routed calls (bind the number to a routing point to give its agents transfers).

A transfer is **a new segment on the same call scope**: one carrier leg, one media link, one
recording, one cost reservation, one call record. Between the outgoing and the incoming segment the
caller hears an **announcement**, then, if the target is not ready yet, a **hold sequence**, and the
incoming agent starts with a **context handover**.

```
requested ──gates──▶ refused (event; the agent keeps talking)
    │ accepted: claim (or queue), compose the target in the background
    ▼
committed ── announcement plays in the outgoing agent's voice; its engine ends; the link stays up
    ├─ target ready ──────────────────────────────▶ connected (route.segment reason transfer)
    └─ not ready ─▶ hold (clips, silence, lines; claim retries every 3 s when queued) ─┐
                    ready ◀──────────────────────────────────────────────────────────────┘
                    compose failed / start failed / maxSeconds ─▶ onTimeout chain
 caller hangs up at any point ─▶ hold stopped, prepared graph disposed, claim released
```

Every handoff uses this one path: an agent's `transfer_to_agent` tool, a flow end node listed in
`handoff.agents.nodes`, a re-route through a routing node, the hold timeout chain, and the router's
own start-of-call handoff (its connecting line is the announcement; a slow or full target is held
instead of making the caller wait in silence).

### Where it is configured

- **The routing point owns the catalogue** (`RoutingPointDraft.transfer`), pinned at publish like
  every R1 target (snapshot `schemaVersion: 2`): keyed `targets` (`destination` a `pool`, the
  agent's `same-pool`, an `agent`, or a routing `node` to re-route through), who may use each
  (`from`: pools, members or agents; absent = every agent segment), the announcement and queue
  announcement, `confirm` (`never` or `ask`), the `hold` policy (point-level, overridable per target),
  `limits` and the `handover` policy. An LLM never names a release, pool or node: it picks a key.
- **The agent release opts in** (`AgentConfig.handoff.agents`): `llmTool` offers `transfer_to_agent`
  with the targets granted to it; `nodes` maps flow end nodes to target keys; `line` is its own
  transfer line; `inbound.greeting` (`opening`, `line` or `llm`) and `inbound.returnLine` decide how it
  greets a transferred or returned caller. The tool id `transfer_to_agent` is reserved when offered.

```json
"transfer": {
  "announcement": { "en": "Let me transfer you to the right team. Please stay on the line." },
  "hold": {
    "steps": [ { "kind": "clip", "assetId": "<music>", "maxSeconds": 25 },
               { "kind": "line", "line": { "en": "Thanks for holding, you'll be connected shortly." } } ],
    "maxSeconds": 180, "waitForCapacity": true,
    "onTimeout": [ { "kind": "return" }, { "kind": "default" },
                   { "kind": "callback", "inMinutes": 60, "line": { "en": "We'll call you back. Goodbye." } } ]
  },
  "targets": [
    { "key": "billing", "description": "Payments, refunds, double charges",
      "label": { "en": "our billing team" },
      "destination": { "kind": "pool", "poolId": "<billing pool>" },
      "from": [ { "kind": "pool", "poolId": "<sales pool>" } ] },
    { "key": "another_language", "description": "The caller wants another language",
      "destination": { "kind": "node", "node": "language" } },
    { "key": "senior", "description": "A senior colleague", "confirm": "ask",
      "destination": { "kind": "same-pool", "skills": ["senior"] } }
  ]
}
```

Hold clips are uploaded as WAV (`POST /v1/routing/audio?name=…`, PCM 8/16-bit, mu-law or A-law,
mono or stereo, 8-48 kHz, 0.1-300 s), converted once to 8 kHz mu-law, stored in the operations
database (migration 011) and pinned in the release by sha256. A clip a live draft names cannot be
deleted; a deleted clip stays playable for the releases that pinned it.

### Hold

The worker plays the effective hold (the target's, else the point's, else the default: 3 s silence,
then the built-in reassurance line, looped for 60 s, then the default agent, then the built-in end
line) on its own media lease, so every hold byte is recorded. Steps play in order, then loop from
`loopFrom`: `clip` (sent in 20 ms frames, cut at its `maxSeconds`), `silence`, and `line` (spoken in
the point's house voice, the router release's TTS, through the speech cache; pre-rendered at
publish). Hold stops the moment the incoming agent sends its first audio, so an LLM greeting never
meets dead air. Caller audio and keys during hold are recorded but not acted on.

`onTimeout` (must end in `default`, `callback` or `end`) runs on compose failure, start failure or
`maxSeconds`, while the hold keeps playing: `target` (another key), `default`, `return` (back to the
agent that transferred, which says its return line; skipped on the router's own handoff), `human`
(R3; skipped), `callback` (promised in the house voice, then the call ends), `end`. A chain that
runs out tries the release's default agent once, then says the built-in end line and hangs up.

### Handover

The incoming agent loads its own release: prompt, tools, voice, language, STT and TTS (a Hindi
member gets Hindi STT whatever the previous segment spoke; its STT pre-connects during the
announcement). It receives a `TransferHandover`: who transferred and why, the summary the
transferring LLM wrote (a required tool argument when `handover.summary` is on), the last
`handover.transcriptTurns` turns (at most 6000 characters), the route context, the call's captured
variables **filtered to what its variable schema declares and accepts** (`filterDeclaredVariables`),
and the disclosure kinds already heard. The handover reaches its LLM as a fenced data section, never
as instructions, and is never logged, evented or stored. Disclosure parts (identity, AI, recording,
opt-out hint) are said once per call: a later segment skips the kinds already heard in full.

### Gates and limits

| Gate                                                                              | Refusal                                 |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| Flag off, or a direct (unrouted) call                                             | tool never offered                      |
| One transfer in flight                                                            | `busy`                                  |
| Key unknown, or not granted to this segment by `from`                             | `unknown_target`, `not_granted`         |
| `limits.maxTransfers` (default 3, at most 10) and 16 segments per call            | `limit_reached`, `segments_exhausted`   |
| Less than `limits.minRemainingSeconds` (default 30) of the call limit left        | `time_exhausted`                        |
| `confirm: ask` and the caller did not say yes to the confirm question             | `not_confirmed` (the question is asked) |
| The same release, or (`returnToPrevious: refuse`) a release the call already left | `same_agent`, `ping_pong`               |
| Every eligible pool member full and no `waitForCapacity`                          | `pool_full` (the agent keeps its claim) |

| What                                    | Limit                                                 |
| --------------------------------------- | ----------------------------------------------------- |
| Targets, sources per target             | 32, 50                                                |
| Hold steps, timeout steps, hold time    | 12, 5, `maxSeconds` 5-900 (120)                       |
| Transfers, segments per call            | `maxTransfers` 1-10 (3), 16                           |
| Summary, reason, transcript handed over | 1000, 200 characters; 0-20 turns (6), 6000 characters |
| Hold clip                               | 0.1-300 s, upload at most 10 MiB                      |

### Failures

| Failure                                               | Behaviour                                                 | Recorded as                                        |
| ----------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| A gate refuses                                        | The agent gets the refusal and keeps helping              | `transfer.requested` `refused` with the code       |
| Barge-in before commit                                | Prepared graph disposed, new claim released, old one kept | `transfer.completed failed cancelled`              |
| Barge-in on the announcement                          | The committed transfer proceeds                           |                                                    |
| Target not ready when the announcement ends           | Hold                                                      | audit `transfer.hold.started`                      |
| Target fails to compose, or exceeds the prepare bound | Timeout chain at once (hold keeps playing)                | `transfer.completed` steps, `compose_failed`       |
| Queued with no capacity by `maxSeconds`               | Timeout chain                                             | reason `hold_timeout`                              |
| Target engine fails to start                          | Timeout chain                                             | reason `start_failed`                              |
| Hold clip missing or a hold line fails to render      | Step skipped                                              | audit `transfer.hold.clip_missing` / `line_failed` |
| Every step fails                                      | Release default agent, then the built-in end line         | `transfer.completed ended`                         |
| Caller hangs up during announcement, hold or compose  | Call ends; hold stopped; graph disposed; claim released   | `transfer.completed caller_hangup`                 |
| Claim storage down                                    | Proceeds unclaimed (capacity is soft)                     | audit `transfer.claims.unavailable`                |

### Telemetry, cost and the inspector

- Session events `transfer.requested`, `transfer.completed`, `segment.ended` and `disclosure`, plus
  `route.segment` reasons `transfer`, `return` and `reroute`, carry keys, codes, ids and timings
  (`prepareMs`, `queueMs`, `holdMs`, `gapMs`, per-segment `durationMs`), never caller words or the
  LLM's text. Every call event of a segment carries `segment: <index>`.
- The call outcome (migration v3) keeps `segments` (one per segment, with timing and how it ended)
  and `transfers` (requested, refused, connected, failed). After a failed handoff start the route
  names the fallback agent that actually answered (`degraded: target_start_failed`).
- The ledger tags every usage row with its segment (`segment_index`, ledger migration 005);
  `GET /v1/calls/:id/cost` adds `segments`, call-level usage (carrier time, hold voice) first.
  `GET /v1/calls/:id/segments` gives the route path with segments, transfers and per-segment cost.
- Logs (ids and codes only): `route_decided`, `transfer_requested`, `transfer_connected`,
  `transfer_failed`, `transfer_hold_timeout`.

### Publish checks (R2 issue codes)

Structural: `routing_transfer_key_duplicate`, `routing_transfer_node_unknown`,
`routing_transfer_timeout_not_terminal`, `routing_transfer_timeout_target_unknown`,
`routing_transfer_hold_loop_invalid`, `routing_transfer_return_unused` (warning),
`routing_transfer_human_unavailable` (warning); transfer lines go through the default-language and
allowed-language checks. Resolution: `routing_transfer_agent_missing`,
`routing_transfer_pool_missing`, `routing_transfer_pool_deleted`, `routing_transfer_audio_missing`,
`routing_transfer_audio_deleted`, `routing_transfer_line_builtin_missing`,
`routing_transfer_disabled` (warning, flag off), `routing_transfer_unreachable` (warning: no release
opts in), `routing_transfer_source_unknown` (warning), and `routing_router_is_only_release` (the
router and every target are one release).

### Turning it on

1. Upload hold clips (`POST /v1/routing/audio`), add `transfer` to the point's draft, publish, and
   re-bind the number to the new routing release.
2. On each agent release that should transfer: `"handoff": { "agents": { "llmTool": true,
"inbound": { "greeting": "llm" } } }`.
3. Set `OVO_ROUTING_TRANSFER_ENABLED=true` for the api and the workers (Compose `.env`, or
   `enable_routing_transfer` on AWS) and redeploy. `GET /v1/routing/status` reports
   `transferEnabled`. Turning it off again takes effect for the next call.

## Failure modes (routing)

| Failure                                                                                  | Behaviour                                                                  | Recorded as                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Routing off, number bound to a routing release                                           | Admitted to the release's default agent                                    | admission `detail.routingDisabled`                                                                 |
| An engine times out, errors or is disabled                                               | Next engine of the node                                                    | `route.node` `timeout`, `error`, `disabled`                                                        |
| LLM replies text instead of calling `ovo_route`                                          | `no_match`, next engine                                                    | `route.node` reason `llm_text_reply`                                                               |
| External webhook: non-2xx, redirect, private address, oversize, bad JSON, unknown branch | `error`, next engine                                                       | `route.node` reason `http_<status>`, `redirect`, `policy`, `oversize`, `invalid`, `unknown_branch` |
| No engine decides                                                                        | The node's fallback chain                                                  | `route.fallback`                                                                                   |
| Pool full, or nobody eligible (language, hours, product, skills)                         | Next fallback step                                                         | `route.fallback default failed pool_full` / `no_eligible_member`                                   |
| Claim storage down                                                                       | Proceeds without a claim (capacity is soft)                                | `route.fallback` reason `claims_unavailable`                                                       |
| Chosen agent cannot be composed within the prepare bound                                 | Abandoned, next fallback step                                              | reason `compose_failed` / `timeout`                                                                |
| Every step fails                                                                         | Release default target; if that fails too, the built-in end line           | `route.fallback release_default`                                                                   |
| Turn or time limit (`limits.maxTurns`, `maxRouteSeconds`)                                | Release default target                                                     | `route.fallback limit`                                                                             |
| Caller silent                                                                            | Idle prompts, then the node's chain as a no-input turn                     | `route.fallback`                                                                                   |
| Caller hangs up while routing                                                            | Call ends; prepared graph disposed; claim released                         | `call.outcome`; `route` ids stay empty                                                             |
| Router cannot compose or the snapshot cannot load                                        | Degraded: the default agent answers as segment 0                           | `route.decision degraded`                                                                          |
| Target fails to start after the router ended                                             | One attempt with the default target, else end `error:route-handoff-failed` | `route.segment` reason `fallback`; the outcome names the fallback agent                            |
| Worker crash mid-call                                                                    | As today; the member claim lapses at `expires_at`                          |                                                                                                    |

## Limits

| What                                        | Limit                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Nodes per tree, depth from the root         | 100, 8 levels                                                      |
| Branches, engines, fallback steps per node  | 32, 4, 6                                                           |
| Rules per engine, matchers per rule         | 64, 8                                                              |
| Members per pool, pools per release         | 100, 50                                                            |
| Languages per point, lines per language map | 12, 12 (each line 1-500 characters)                                |
| Router turns, routing time                  | `limits.maxTurns` 1-20 (6), `maxRouteSeconds` 10-300 (90)          |
| External webhook                            | one attempt, 100-5000 ms, 16 KiB response, HTTPS public hosts only |
| Prepare bound                               | `OVO_ROUTING_PREPARE_TIMEOUT_MS`, 500-10000 (2500)                 |
| Route session event payload                 | 8 KiB, like every session event                                    |

## Security and data

- Every routing row is keyed by organization; the worker refuses a handoff to any release not in
  the snapshot's `releaseIds`. Viewers read, editors edit and publish, admins bind numbers; every
  mutation is audited.
- Route events carry branch keys, engine names, confidences and ids, never caller words or phone
  numbers. The external webhook gets the caller number only with `send.callerId: true` and the turn
  text only with `send.turnText` (on by default).
- The webhook secret is a credential resolved by the worker for the router agent; it never enters
  the plugin, the snapshot, an event or a log. Requests carry `x-ovo-timestamp` and
  `x-ovo-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<requestId>.<raw body>")>`; receivers
  should refuse a skew over 300 s and a replayed request id.
- The `ovo_route_` variable prefix is reserved; inbound route variables using it are refused.
- One recording and one cost reservation per call, both decided by the router release; publish
  refuses a member whose meters the router's cost policy does not price.

## Where the code lives

| Package                        | What                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`           | `src/routing/*`: schemas, `routingDraftIssues`, the `RoutingHost` and `SegmentHandoffPort` ports, `route.*` payloads; `Cap.routing`, `Cap.segmentHandoff`. |
| `packages/plugin-operations`   | Migration 010, `OperationsService.routing` (pools, points, releases, claims), `effectiveInboundRoute`, routed admission.                                   |
| `packages/plugin-storage`      | Outcomes migration v2 (`route` column) and the fold of `route.decision` / `route.segment`.                                                                 |
| `packages/plugin-router`       | The router behaviour: pure `RouterCore`, engines, fallback chain, member ranking.                                                                          |
| `apps/worker`                  | Routed sessions, segment controller (the handoff seam), routing host, external webhook client.                                                             |
| `apps/api`                     | `/v1/routing/*`, publish validation, the inbound route target union.                                                                                       |
| `apps/media-gateway`           | The routed pre-admission check and `OVO_ROUTING_ENABLED`.                                                                                                  |
| `packages/plugin-speech-cache` | Pre-renders every agent release a routed number pinned.                                                                                                    |
| R2: `packages/contracts`       | `routing/transfer*.ts`, `routing/audio.ts`, `routing/voice-lines.ts`, `agent-to-agent.ts`, `agent-variables.ts`; `Cap.agentTransfer`.                      |
| R2: storage                    | Operations migration 011 (`ovo_routing_audio`, `ovo_routing_point_audio`), outcomes v3, ledger migration 005; `routedVoiceLines` pre-render listing.       |
| R2: runtime                    | `apps/worker` transfer controller, hold player, handover; `packages/behaviors` and `packages/plugin-router` transfer paths; `apps/api` audio and segments. |

## What later waves add

- **R2, in-call transfer:** built in Wave 16; see [above](#in-call-agent-transfer-wave-16-r2).
- **R3, human queues:** `kind: 'human'` joins `SegmentHandoffRequest` and transfer destinations; the
  `human` routing and hold-timeout steps already validate (with a warning) and are recorded when
  skipped. The hold player plays while a ticket waits for an operator.
- **R4, designer and visibility:** the designer edits the same `RoutingPointDraft`; the simulator and
  `packages/eval` routing accuracy drive the pure `RouterCore`; the inspector shows `route.segment`
  timings per segment.
