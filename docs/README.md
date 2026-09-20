# OVO build documentation

Status: implementation specification; no application has been implemented or benchmarked by this documentation commit. Prepared 20 September 2026.

OVO is the Open Voice Orchestrator: an open-source, TypeScript-first voice-agent platform built through replaceable plugins, with a complete operating console. This documentation is intended to let a coding agent proceed from research through implementation without guessing the product.

## Read in this order

1. [Product brief](01-product-brief.md): product, bot modes, boundaries, user journeys, release scope.
2. [Agent implementation guide](02-agent-build-guide.md): execution instructions, package names, decisions, workflow.
3. [Stack research plan](03-stack-research.md): mandatory research, experiments, evidence and decision gates.
4. [Architecture and contracts](04-architecture.md): runtime, plugins, data, scheduling, tools and playback.
5. [Frontend and configuration](05-frontend.md): screens, all configurable fields, secrets, UX and API behavior.
6. [Engineering work breakdown](06-engineering-plan.md): dependencies, work packages, effort, milestones and deliverables.
7. [Acceptance and operations](07-acceptance.md): testable criteria, benchmarks, failure cases and release gates.

8. [Plugin-first and Fargate mandate](08-plugin-first-fargate.md): enforceable plugin boundaries, production scaling, admission and draining.
9. [Upstream research assignment](09-upstream-research-assignment.md): mandatory source inspection and comparative spikes before choosing the engine.

These documents supersede earlier exploratory recommendations that presumed LiveKit was mandatory or that the complete voice runtime must be Python. The implementation direction is TypeScript, informed by Pipecat's execution design and built through direct reuse of DeepSeek Harness's plugin foundation. Research must determine which existing libraries to reuse; a full Pipecat clone is not required. Runtime choice cannot silently remove required product capabilities.

The [DeepSeek source-reuse mandate](11-deepseek-foundation.md) supersedes earlier suggestions to build an independent plugin host. Directly reuse/adapt the upstream foundation; voice-engine selection remains a research task.

## Fixed requirements

- First-party npm packages use `@winsendotai/ovo-*`; keep the GitHub repository at its existing owner. Do not rename upstream dependencies or publish anything merely because it has a package name.
- **Everything that implements an application capability is a plugin**, including the conversation engine, policies and console extensions, with explicit contracts and lifecycle. The minimal bootstrap and contract definitions are shared foundations.
- Use ECS Fargate as the primary production deployment and scaling target. Keep single EC2 as a secondary compact-install profile using the same agent configurations and worker code.
- Support announcement-with-variables, no-generative-LLM FAQ, supplied-context conversational, and tool-using agent bots.
- Voice-agent settings, knowledge, prompts, tools, processing speech, providers, and provider secrets must be configurable through the frontend by an authorized operator.
- Console authentication, platform IAM, TLS, VPC, and infrastructure bootstrap are not voice-agent settings. This is what “not for the access” means here. Keep a basic permission boundary; do not build a large identity-management product.
- Every authorized user-facing tool/check operation receives configurable spoken processing text, such as “Please wait while I check that.” This is enforced in code, not left to prompt compliance.
- Build the management/observability console alongside the runtime; a working CLI alone is not product completion.

## Requirement precedence

User instructions > applicable repository instructions > confirmed requirements in this pack > approved architecture decisions > proposed defaults. Record contradictions in the decision log. Do not call a proposal an approved decision or a test target an achieved result.

## Build evidence to maintain

Create `docs/research/`, `docs/decisions/`, and `docs/evidence/` as work proceeds. Maintain `docs/progress.md` with work-package status, test evidence, blockers, and next steps. Do not mark a work package done without its acceptance evidence. These are future implementation outputs, not claims that research/benchmarks already exist.
