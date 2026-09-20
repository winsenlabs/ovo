# Plugin-first architecture and Fargate deployment mandate

## 1. Architectural requirement

**Everything that implements an OVO application capability is a plugin.** This includes the conversation loop itself. Provider swapping alone does not satisfy this requirement. The small foundation defines contracts, loads the dependency graph, establishes scopes and enforces platform boundaries. It must not contain a hidden default model, business behavior, carrier, database or speech scheduler.

DeepSeek Harness is the composition reference: its architecture places services and the agent loop behind plugins. OVO must independently define the voice-specific contracts and verify their real-time behavior. See [DeepSeek architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md). This is design inspiration, not a decision to embed the whole coding-agent product.

| Replaceable capability | Contract / required responsibility |
|---|---|
| Conversation engine | Session execution, cancellation, bounded continuation and lifecycle |
| Bot behavior | Announcement, deterministic FAQ, supplied context, tool-using agent |
| Telephony control | Dial, hangup, transfer, carrier callbacks and reconciliation |
| Media transport | Audio ingress/egress, codec negotiation, flush and playback evidence |
| Speech input | VAD, turn detection, STT and accepted-transcript semantics |
| Speech output | TTS, pronunciation, cached assets and playback scheduling |
| Inference | Streaming model requests, structured tools, cancellation and usage |
| Business tools | Validated invocation, permissions, confirmation and side-effect identity |
| Conversation policies | Processing speech, progress speech, turn-taking and recovery |
| Knowledge | FAQ matcher, supplied context and optional retrieval |
| Durable services | Job queue, event store, configuration store, artifacts and secret resolution |
| Operations | Admission/capacity policy, recording, telemetry, evaluation and cost accounting |
| Console extensions | Schema-driven settings, inspector panels and versioned routes |

A replaceable policy must still satisfy mandatory product invariants. For example, replacing the acknowledgment plugin cannot silently disable processing speech for user-facing checks. Infrastructure IAM, network trust and the authenticated bootstrap are platform boundaries, not caller-editable plugins. AWS services themselves are external infrastructure; OVO's adapters to them are plugins.

## 2. Rules that make the claim testable

1. Concrete SDK imports belong to adapters. Domain behaviors depend on contracts. CI rejects forbidden dependency edges.
2. All plugins, including first-party defaults, declare capabilities, dependency versions, configuration schema, secret references, scope and disposal. No privileged registration path for built-ins.
3. An immutable release resolves an explicit plugin graph. Its effective configuration is inspectable in the console with secret references redacted.
4. The host rejects cycles, missing dependencies and ambiguous exclusive capabilities before release. Unsupported combinations have specific errors.
5. Process clients may be pooled; call state is session-scoped. Cleanup is idempotent. New versions affect new sessions; an active call cannot have its engine unloaded underneath it.
6. Prove an engine replacement and a provider replacement without modifying behavior code. Prove announcement/FAQ sessions without an LLM plugin installed or invoked.
7. Build a sample external plugin against only the public SDK. It must add settings and telemetry through supported extensions without editing application internals.
8. Plugin installation is an operator-controlled deployment action. Agent users configure installed capabilities and credentials; callers and models cannot install executable code.

Plugins are primarily in-process modules, not individual network services. Do not add serialization and HTTP hops between STT frames, policies and playback merely to look modular. Split processes for a measured isolation or scaling need. Do not attempt every possible provider combination: publish a certified compatibility matrix and run conformance tests for advertised combinations.

All first-party packages retain `@winsendotai/ovo-*` naming. The core must remain small through dependency checks and architecture review, not an arbitrary line-count target.

## 3. Why Fargate is the primary production profile

Fargate supplies managed container compute; ECS schedules services and manages task count. This fits OVO's long-lived streaming sessions and external inference API calls without operating an EC2 fleet. Tasks have declared resources and workload identities; workers can be replaced and deployed independently of the management services. The agent loop and provider API orchestration live in the worker container throughout the call.

Fargate is the default production implementation and first load-certification target. The single-EC2 profile remains a secondary compact-install option from the earlier requirements, using the same images and contracts. It must not dictate the production architecture. No Lambda-per-call runtime is required.

This choice trades host administration for managed-compute pricing and startup constraints. It does not make inference cheaper, guarantee instant startup or remove networking work. Continuously busy EC2 capacity may be cheaper; benchmark before making a comparative claim. Linux Fargate billing is per second with a one-minute minimum and includes startup and idle allocation; see [Fargate pricing](https://aws.amazon.com/fargate/pricing/). Zero idle is a cost scenario, not a guarantee.

“All on Fargate” means OVO application compute, with explicitly declared managed dependencies such as SQS, database, S3 and Secrets Manager. External carrier and AI APIs remain external. LiveKit media/SIP/egress deployment must pass the networking feasibility gate; Docker availability does not establish Fargate compatibility. If it fails, select a certified direct transport or record a requirements conflict rather than hiding an EC2 media server.

## 4. Service topology and scaling responsibility

Use separate ECS services for control API/console, dispatcher/capacity coordination, call workers, any required media gateway and postprocessing. A task initially has one active call slot; it can serve different agent releases sequentially after cleanup. One hundred calls need one hundred admitted slots, not one hundred service definitions.

ECS Service Auto Scaling uses Application Auto Scaling and CloudWatch metrics to adjust desired task counts; SQS does not directly launch workers. Queue-based signals need a configured policy. Built-in ECS metrics arrive at minute intervals, so scaling must not sit on the conversational response path. See [ECS scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html).

Implement one authoritative capacity decision path per service. Recommended first implementation: a leader-fenced capacity controller in the dispatcher publishes an absolute required-capacity metric; a documented scaling integration applies desired capacity. Choose either that controller as the sole desired-count writer or Application Auto Scaling policies as the writer through an ADR. Do not run conflicting custom writers and target-tracking policies. Scheduled prewarming must enter the same decision path.

Required inputs:

- Healthy ready-idle, reserved, active, starting and draining worker counts, with timestamp/lease freshness.
- Eligible unclaimed jobs and oldest eligible queue age; raw approximate SQS depth is corroborating evidence, not exact business truth.
- Campaign schedules, inbound warm floor, measured startup percentile and admissions rate.
- Carrier calls-per-second/concurrency, AI quotas, AWS task/vCPU limits, connection limits and configured spend ceiling.
- CPU, memory, event-loop lag and provider error rate as capacity health signals. Low CPU while waiting for APIs does not mean the slot is free.

Illustrative one-slot policy: `required = active + reserved + min(eligibleUnclaimed, permittedNewStartsInHorizon) + warmIdleTarget`. Counts are mutually exclusive. Clamp to configured capacity bounds; never admit beyond actual ready slots or provider budgets. If a new cap is below existing commitments, stop new admission and drain naturally. Starting tasks count toward already provisioned desired capacity; do not add them again on every tick. Derive the planning horizon from measured startup and queue-wait objectives. Implement hysteresis, bounded scale-out steps, slower scale-in and stale-metric handling; tune using measured bursts rather than invented universal defaults.

Scale-to-zero is suitable for scheduled/outbound work with acceptable startup delay. A live producer/control service must publish demand even with zero workers; test that wakeup explicitly. Inbound low-latency service needs warm capacity or an explicit overflow route. Prewarm campaign workers and validate credentials/media before dialing. Never dial first and hope a container becomes ready during the greeting.

## 5. Admission, protection and draining

The dispatcher reserves a ready slot conditionally with an ownership epoch. Before accepting call work, the worker confirms it is not draining, establishes scale-in protection, and rechecks ownership/readiness. Protection failure blocks admission. Queue visibility and the durable call lease are separate mechanisms; heartbeat both where applicable, and release the queue item according to the durable job protocol.

For scale-in or rollout: close admission, keep active workers protected, wait for calls to settle, finish bounded cleanup, release the reservation/protection and retire idle tasks. Renew protection before expiry and alert on renewal failures. ECS protection applies to service tasks, has a configurable expiry and can delay deployments; it does not prevent crashes or every termination cause. See [task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html).

Allow rollout headroom for replacement tasks. A drain deadline or task termination warning invokes the documented call fallback; never claim a brief process shutdown timeout can preserve an arbitrarily long call. Gateway routing must stop sending new sessions to draining workers and preserve established media where supported. Disrupted calls enter reconciliation; they are not automatically redialed.

## 6. Console and operational evidence

Platform operators need desired/running/starting/ready/reserved/active/draining counts, oldest eligible job age, protection health, startup percentiles, rejected admissions, limiting quota, last scale decision and reason. Show worker startup/idle cost separately from connected-call cost. Configuration includes warm floor, maximum capacity, schedule, admission budget and alert thresholds within platform-authorized bounds. Ordinary agent builders do not get IAM or unrestricted infrastructure access.

Required drills: zero-to-demand wakeup; queue empty while calls remain active; burst beyond quota; slow task startup; stale metrics; worker crash; protected rollout; protection renewal failure; safe return to zero after settlement. Record timestamps, call outcomes, duplicates, costs and scaling decisions. Task count alone is not evidence that callers received acceptable service.

## 7. What would make OVO exceptional

“Best voice orchestrator” is an ambition, not an architectural property. Define the initial segment as teams operating configurable telephone agents, including deterministic and LLM modes, on their own AWS infrastructure.

Measure OVO against a current Pipecat reference and LiveKit Agents JS using matched providers, languages, audio, tools, regions and load. Compare meaningful response latency, interruption correctness, side-effect safety, successful task completion, setup effort, debugging time and fully allocated cost. Publish failures and sample sizes. An acknowledgment does not count as a completed answer.

The intended advantage is the combination of interchangeable capabilities, excellent voice execution, frontend control of all agent settings, understandable call evidence and reproducible operations. Fargate and plugin packaging support that outcome; neither proves it. Launch claims must remain limited to certified scenarios and measured results.
