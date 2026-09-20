# Build-agent prompt

Copy the following into your coding agent with the `winsenlabs/ovo` repository attached.

```text
Build OVO (Open Voice Orchestrator) in this repository. Treat this as an implementation task: research, make evidence-backed decisions, write working code, verify it, and maintain progress. Do not stop after producing another plan.

First inspect the repository and applicable instructions. Read README.md, docs/README.md, and numbered specification files 01–09 and 11. Preserve existing work. Use docs/06-engineering-plan.md as the work breakdown and docs/07-acceptance.md as the acceptance contract.

Begin with the mandatory research in docs/09-upstream-research-assignment.md. Inspect current official documentation, source, and tests for DeepSeek Harness, Cordis, Pipecat, LiveKit Agents JS, and Vercel AI SDK. Record exact versions/commits, licenses, source links, verified capabilities, and gaps. Build the required narrow comparison prototypes. DeepSeek Harness is the required implementation foundation: directly reuse/adapt its actual plugin composition and lifecycle code with Cordis. Follow docs/11-deepseek-foundation.md. Pin the upstream commit, preserve copyright/license notices, map imported modules and changes, and define an upgrade path. Do not build an independent imitation of its plugin host. Decide voice-engine and integration choices through ADRs. Do not blindly port Pipecat or assume LiveKit is required.

Non-negotiable requirements:
- Everything implementing an application capability is a plugin, including the conversation engine, behaviors, policies, providers, tools, persistence adapters, and console extensions. Enforce boundaries and lifecycle contracts with tests. Keep the bootstrap small.
- TypeScript first. Name first-party packages @winsendotai/ovo-*. Do not publish packages as part of implementation.
- ECS Fargate is the primary production profile. SQS carries jobs, never realtime audio. Implement readiness before dialing, quota-aware admission, warm inbound capacity, scale-from-zero for suitable workloads, active-call protection, and safe draining. Retain the secondary EC2 profile described in the specs.
- Implement an MCP client connector plugin: frontend-configured server/auth, per-agent tool allowlists, server-side credentials, schema validation, and the shared policy/acknowledgment/execution layer. Also support direct HTTP and native tool plugins.
- Support variable announcements, deterministic no-LLM FAQ bots, supplied-context conversations, and tool-using agents.
- Every user-facing tool/check operation gets configurable spoken processing text, enforced in code. Handle fast results, interruption, retries, and uncertain side effects correctly.
- Build the real management frontend alongside the runtime. All voice-agent settings and provider credentials must be configurable there. Credentials are write-only and resolved server-side; platform access/IAM remains separate.
- Deliver real call observability, recordings, evaluations, versioned releases, and INR/paise cost accounting. Clearly distinguish estimated data, simulations, and verified provider behavior.

Implement vertical slices with working APIs, persistence, frontend, and meaningful tests. Establish the deterministic interruption/playback test harness early. Maintain docs/progress.md with work-package status, decisions, evidence, blockers, and next actions. Update the public README as runnable features become available.

Continue authorized local implementation without asking for approval on routine engineering choices. Never invent credentials, benchmark results, or successful integrations. Do not deploy paid infrastructure, publish packages, or call real customers without authorization. If a provider/account blocks live verification, use explicit test adapters, report the gap, and continue independent work.

Start now with repository inspection and the research phase, then proceed into implementation. At each checkpoint report what works, what was tested, what remains, and any concrete blocker. Do not mark a work package complete until its acceptance evidence exists.
```
