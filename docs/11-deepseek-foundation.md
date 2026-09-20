# DeepSeek Harness foundation: required source reuse

## 1. Confirmed direction

OVO must directly reuse and adapt actual DeepSeek Harness implementation code for its plugin foundation. “Inspired by DeepSeek,” independently recreating similar interfaces, or using Cordis alone without identifiable DeepSeek source reuse does not satisfy this requirement. This decision supersedes the earlier option of building a separate minimal registry.

Everything implementing an application capability remains a plugin, including the conversation engine. The research task is to determine a maintainable import boundary and how to add voice behavior. It is not permission to replace the required foundation silently.

Status: implementation requirement. No upstream source has been imported by this documentation change.

## 2. Import and attribution procedure

1. Inspect the upstream repository, package manifests, architecture, source and relevant tests. Pin a complete upstream commit SHA and the compatible Cordis/dependency versions. Never depend on a moving branch for a released OVO build.
2. Trace the smallest coherent dependency closure for composition/bootstrap, profiles/configuration, scoped services/events and lifecycle/disposal. Identify existing tool, model-adapter and session-event capabilities worth reusing directly.
3. Select pinned upstream packages where the necessary code has stable consumable exports. Otherwise copy/vendor and adapt the required source with traceable origins. Record why a source extraction or maintained fork is necessary. A cosmetic copied utility beside an independent plugin runtime fails the requirement.
4. Maintain `docs/research/deepseek-import-map.md`: upstream commit and path/package, local path/package, direct dependency versus copied source, modifications, dependency closure, license and retained tests.
5. Include the applicable license/copyright text and third-party notices with copied source and distributions. Keep upstream provenance when adapting names. Original OVO packages use `@winsendotai/ovo-*`; unmodified external dependencies retain upstream names.
6. Maintain a patch/change log, upgrade procedure and CI conformance suite. Updating upstream must pass OVO's interruption, session isolation, no-LLM and tool-state tests before release.

The upstream root [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) inspected on 20 September 2026 is MIT and requires preservation of its copyright and permission notice in copies or substantial portions. Verify the exact imported commit and each dependency's notices. OVO's own license is a separate project decision; this mandate does not invent one.

## 3. What is inherited and what OVO adds

| Area | Required approach |
|---|---|
| Plugin foundation | Reuse DeepSeek composition and Cordis integration, scoped services/events, initialization and disposal |
| Configuration | Adapt upstream composition/profile mechanisms to immutable OVO releases and validated frontend configuration |
| Tools and model interfaces | Audit existing implementations and reuse suitable modules; preserve provenance for adapted code |
| Session facts | Audit/reuse useful event contracts; add durable distributed ownership and storage required by Fargate |
| Conversation loop | Remains a replaceable plugin; adapt suitable upstream loop behavior or mount a voice-specific engine under the same foundation |
| Speech and media | Add STT/TTS/turn/playback/transport plugins with verified streaming cancellation and playback-aware context |
| Bot modes | Compose announcement and deterministic FAQ without forcing an LLM loop; add contextual and tool-using modes |
| Management console | Build OVO's agent studio and call operations UX using the shared plugin capability graph |
| Deployment | Add ECS Fargate workers, SQS jobs, readiness, admission, task protection and recovery |

DeepSeek's documented agent-loop and session abstractions are useful starting points, but their existing text-agent behavior is not evidence of voice correctness. OVO must reconcile generated text with actual playback and preserve tool outcomes when speech is interrupted. Do not run an upstream tool loop and a second framework loop that can independently execute the same action.

Keep unrelated coding tools, shell execution, desktop UI and automatic executable-plugin installation out of the voice deployment unless a specific required capability justifies them. Plugin code installation remains controlled by deployment operators. Agent builders configure approved installed capabilities; callers and models cannot install plugins or administer console access.

## 4. MCP is a tool-connector plugin

Implement `@winsendotai/ovo-plugin-tools-mcp` as the proposed first-party MCP client connector package. The MCP server is a separate service; its connection and approved tool bindings become part of an agent's plugin composition. A server owned by OVO may be separately deployed on Fargate, while an external server stays external.

The frontend must support connection label/endpoint, supported authentication, server-side credential binding, connectivity test, tool discovery, explicit per-agent allowlist, input/output schema inspection, processing speech and sandbox invocation. Handle schema changes through release validation and recorded tool-schema versions; discovery never grants access automatically.

Remote HTTP connections are the initial deployment path. Local stdio servers require reviewed packaged processes and lifecycle/resource controls; never accept arbitrary browser-entered shell commands as a shortcut. Scope authentication sessions and credential refresh to the authorized connection and workspace. Do not forward a console login token to an unrelated MCP server.

MCP, direct HTTP and native TypeScript tools all pass through the same validation, authorization, confirmation, acknowledgment, durable operation, deadline, redaction and observation path. Do not assume an MCP server provides idempotency or reconciliation. Writes with ambiguous outcomes need explicit business handling and cannot be blindly retried.

## 5. Build-agent exit evidence

W01 produces the pinned source/dependency/license map and import ADR. W03 imports the actual foundation, demonstrates an OVO composition, runs retained upstream tests where applicable and adds lifecycle conformance. W04 demonstrates voice cancellation and context correctness on that foundation. W11/W14 demonstrate MCP configuration and a real or explicitly simulated tool call with the mandatory processing phrase.

Compare a focused voice engine and LiveKit Agents JS adapter inside the required foundation. Pipecat remains the voice-execution reference. If an upstream limitation blocks a fixed OVO requirement, record the concrete failure and propose a targeted adaptation; do not replace the foundation without an explicit product decision.

Acceptance criteria A73–A75 in [07-acceptance.md](07-acceptance.md) cover the additional evidence. Existing Fargate and voice criteria remain binding. Re-estimate extraction and ongoing maintenance after the source audit.
