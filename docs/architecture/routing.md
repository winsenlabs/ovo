# Routing points, agent pools and the conversational router (Wave 15, R1)

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

R1 hands off once, at the end of routing. Mid-call agent transfer (R2), human queues (R3) and the
routing designer (R4) build on the same seam; see [what later waves add](#what-later-waves-add).

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

## Failure modes

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
| Target fails to start after the router ended                                             | One attempt with the default target, else end `error:route-handoff-failed` | logs with ids only                                                                                 |
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

## What later waves add

- **R2, in-call transfer:** `SegmentHandoffRequest` gains `reason: 'transfer'`, an announcement, a
  hold sequence and a context handover; a `transfer_to_agent` tool reads `Cap.segmentHandoff`. The
  segment controller, media lease and gap buffer are reused unchanged, and each segment gets its own
  telemetry and cost.
- **R3, human queues:** `kind: 'human'` on the same port; the `human` step and target already
  validate (with a warning) and are recorded when skipped.
- **R4, designer and visibility:** the designer edits the same `RoutingPointDraft`; the simulator and
  `packages/eval` routing accuracy drive the pure `RouterCore`; the inspector shows `route.segment`
  timings per segment.
