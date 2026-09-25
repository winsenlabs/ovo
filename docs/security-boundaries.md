# Security boundaries and release gates

This document distinguishes implemented control boundaries from required production certification. The acceptance ledger remains authoritative for completion.

## Trust boundaries

| Boundary                    | Required enforcement                                                                                         | Local implementation direction                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Browser → management API    | Authenticated identity, workspace membership, role, request schema, no caching of secrets                    | Opaque HttpOnly session cookie; server-configured bootstrap identities; same-origin console gateway  |
| Configuration → plugin host | Only installed/approved code, validated manifest/config, closed dependency graph                             | DeepSeek-derived composition wrapper; no arbitrary imports, executable YAML or package installation  |
| Model → tools               | Model output cannot grant permissions or execute effects directly                                            | One shared execution plugin validates schema, explicit per-agent allowlist and write confirmation    |
| Connector → network         | Explicit endpoint policy, no metadata/private-network SSRF, no credential forwarding across redirect         | Operator-approved connector endpoints and hardened HTTP/MCP transports                               |
| Runtime → secrets           | Workspace/agent authorization, expiry and retirement checks, ciphertext at rest, no plaintext in APIs/audits | Secret resolver capability; local AES-GCM adapter and AWS adapter with distinct certification status |
| Worker → carrier            | Durable intent, current ownership epoch, provider readiness and capacity/protection before dial              | Persistent orchestration state machine and SDK adapters; no real calls during this task              |
| Worker → projections        | Durable source truth, versioned envelopes, event identity and ordering, rebuildable views                    | Deterministic projection utility; integration gaps remain explicit                                   |

## Non-negotiable deployment gates

- Do not deploy the local SQLite control profile across Fargate tasks. Complete and test the shared production database adapter first.
- Do not expose the dispatcher/worker internal control APIs to the public internet. Bound task IAM, security groups and credential access to the task role.
- Do not enable real provider calls until readiness, ownership, quota and idempotency checks pass with an owned test number and authorization.
- Do not retry an ambiguous write or dial merely because a transport timed out. Reconcile the durable operation with the provider first.
- Do not log raw provider keys, request bodies, transcripts or tool payloads as ordinary telemetry. Store authorized artifacts separately with retention and access controls.
- Do not mark generated or sent speech as heard. Evidence must identify simulation, estimation or confirmed playback.
- Do not publish packages until the project license and final distribution obligations receive approval.
- Do not treat suspended GitHub Actions as a passing check. Retain local command results and exact source/lockfile identity.

## Local operator identity

The setup script generates random bootstrap, session and encryption values in a private ignored file. The login form uses the bootstrap token once to obtain a session cookie. This bootstrap identity is not enterprise identity management: production SSO, recovery, revocation and operator lifecycle remain separate acceptance work.

No production secret was requested or required for deterministic local fixtures. No customer data belongs in these fixtures.
