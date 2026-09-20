# Product brief

## 1. Product and intended users

OVO lets developers and operations teams create and run voice agents using their own telephony and AI providers. They configure behavior through a frontend, deploy the application in AWS, monitor live calls, review outcomes, investigate errors, and improve agent versions. OVO owns the execution rules and operational experience; it does not train foundation models or sell a compulsory inference endpoint.

Primary users: an agent builder, operations supervisor, quality reviewer, integration developer, and deployment operator. One person can hold several roles. Initial reference domains are airline support and collections reminders. Domain policy belongs in versioned configuration and tools, not hardcoded in the generic engine.

Success means callers receive accurate, responsive interactions, business actions are correctly executed, and operators can explain what happened. Short duration, low token use, or a carrier's completed status does not establish business success.

## 2. Bot modes: all four are required

| Mode | Generation | Input and behavior | Examples |
|---|---|---|---|
| Announcement | No LLM | Render an approved message with typed variables; speak; optionally collect fixed speech/DTMF response | Appointment reminder, flight delay notification, overdue amount reminder |
| FAQ | No generative LLM required | Recognize question/intent, select approved answer, clarify ambiguity; optionally follow a script | Office hours, payment methods, baggage allowance FAQ |
| Supplied-context conversation | LLM | Answer naturally from supplied facts/documents/session data and policy; tools disabled by default | Product explainer, personalized itinerary assistant, account-information conversation |
| Tool-using agent | LLM plus controlled tools | Interpret request, validate/confirm actions, acknowledge checks, execute tools, respond from results | Booking changes, payment-status lookup, extension eligibility, CRM updates |

Modes share media, playback, lifecycle, recording, telemetry and frontend management. They differ in decision-making and required dependencies. No mode must incur LLM calls simply because the worker has an inference plugin installed.

### 2.1 Announcement bots

Example: “Hello {{customer.firstName}}. Your appointment is on {{appointment.date}} at {{appointment.time}}. Press 1 to confirm or 2 to request a callback.”

Configuration includes text segments, typed variable schema, required fields/defaults, source mappings, pronunciation, voice/language, opening/closing, repetition limits, interruption behavior, optional response branches and terminal outcomes. The builder previews with sample payloads and hears the exact rendered message before release.

Missing required variables prevent dial admission; do not read placeholder syntax or make up amounts. Currency/date/time format includes locale/timezone. Template expressions access approved paths only; no arbitrary JS evaluation. Validate values before synthesis. Repeated static segments may use cached audio; dynamic values must preserve correct pronunciation and privacy.

Optional two-way interaction can use DTMF or deterministic speech intents. A one-way bot need not load STT if no speech interaction is configured. Configuring no interruptions is explicit and tested, not a consequence of accidentally not listening.

### 2.2 FAQ bots without generative LLM

The first implementation must work using normalized text, aliases, keyword/lexical scoring, deterministic rules and confidence/margin thresholds. STT/TTS are still model inference, but no generative language-model endpoint is required. Semantic embeddings or trained intent models can be optional plugins; their costs/dependencies must be visible, and they cannot be a hidden requirement for the no-LLM path.

FAQ entries contain ID, canonical question, aliases, approved response, language, tags, applicability, validity window, and escalation action. Test exact match, paraphrase within the supported matcher, negation, similar questions, no match, conflicting matches, and out-of-domain questions. Low-confidence or close competing matches trigger clarification or handoff. Do not force every question to the nearest answer.

Example: “Can I pay later?” may map to an approved general answer. If the answer depends on that customer's eligibility, it requires a policy/tool operation; the FAQ alone must not grant an extension. No-LLM FAQ mode may invoke an explicitly wired deterministic lookup, with the same acknowledgment and tool policies as an agentic call.

A builder can run a labelled question set in the frontend, inspect matching evidence and adjust aliases/thresholds without source changes. Show mode boundaries honestly: unrestricted natural-language understanding is not promised by keyword matching.

### 2.3 Supplied-context conversational bots

The builder supplies instructions, facts, FAQs/documents, tone, allowed topics, uncertainty behavior, verification requirements, model binding, limits and sample conversations. Per-call facts are schema-validated and tenant-scoped. Sources and publication versions are traceable.

“All information provided” does not mean arbitrarily large prompts. Implement a documented context budget, deterministic assembly, truncation/retrieval strategy, and explicit failure when critical material cannot fit. Initially support text, Markdown and structured JSON/CSV. Broader document parsing is a later plugin unless research justifies a bounded implementation.

No account mutation, external lookup, or tool is available unless explicitly enabled. Responses outside provided information must admit uncertainty or hand off. Model instructions are not guarantees: evaluate factuality with known-answer and unanswerable examples and enforce permissions outside the model.

### 2.4 Tool-using agents

Tools may be approved built-ins, operator-configured HTTP connectors, or certified plugin tools. Frontend configuration includes description, argument/result schemas, endpoints, credential reference, timeout, retry and idempotency strategy, allowed states, confirmations, redaction, and acknowledgment speech. Arbitrary executable code from the browser is not required and is excluded at launch.

Examples: read account balance; inspect payment status; check flight alternatives; create callback; record a payment intention; submit a confirmed booking change. Distinguish read-only, reversible write, irreversible write, and externally uncertain outcomes.

Runtime sequence: validate request and permissions → obtain required caller confirmation → durably record intent → enqueue acknowledgment and start operation → persist result → speak result when playback permits. A check that completes instantly still receives its configured acknowledgment. One logical operation can group several backend API calls under one acknowledgment.

If caller interrupts, stop obsolete speech. Keep a committed business result and reconcile a request already accepted externally. Never tell the customer something succeeded merely because a request was submitted.

## 3. Required processing speech

This is a shared product capability across modes. Workspace defaults, agent overrides, and tool/operation overrides are editable from the frontend, with deterministic precedence: operation > agent > workspace. Provide per-language phrases and optional variants. All allowed paths resolve to a phrase before publication.

Examples: “Please wait while I check your balance”; “Let me check the available flights”; “I'm checking whether an extension is available.” Grammar and pronunciation are editable. The example text is not hardcoded into the engine.

Configure initial acknowledgment, bounded delayed progress update, failure wording, interruption behavior, cache policy, voice inheritance, and operation grouping. Ordinary internal inference/STT/logging calls are not each narrated. A customer-facing check is. Prevent the model and middleware from speaking duplicate acknowledgments using an operation ID and explicit acknowledgment state, not substring guessing alone.

Acknowledgment and tool run concurrently. Results wait for the phrase to finish or be intentionally interrupted/superseded. Progress phrases stop when the operation settles. All speech passes through one scheduler and appears in the call inspector.

## 4. Main journeys

### Builder

Create agent → choose mode/template → configure provider credentials/bindings → configure language/voice → enter message/script/FAQ/context/tools → set acknowledgments/fallback/limits → test with sample input and sandbox tools → review validation and diff → publish immutable version → bind phone number or campaign.

### Operator

Open overview → see queue/capacity/provider health → inspect active calls → pause new work or transfer/end a permitted call → review failures → open precise latency/cost/tool evidence → annotate/escalate → compare releases and roll back new-call routing if necessary.

### Developer

Implement plugin against contracts → run conformance suite → supply UI schema/capabilities → register approved artifact/version → test compatibility → ship versioned release. Plugin authors do not edit every behavior implementation to add a new provider.

## 5. Scope

Launch: all four modes, one production-certified carrier path, outbound and inbound, one human escalation path, both AWS deployment profiles, provider-secret management in console, durable calls/tools, recording where enabled, replay/evaluation, release versioning, cost and performance views, SDK/API and install documentation.

First milestone is smaller: one announcement and one acknowledged tool check on a real test number, with interruption and persisted result. Later milestones add the complete launch scope; a milestone demo is not full product completion.

Defer public plugin marketplace, arbitrary untrusted code, foundation-model training, autonomous self-improvement, payment collection/invoicing for OVO, omnichannel messaging, active-active multi-region, and general-purpose visual workflow programming. Browser microphone testing is included; an end-customer browser calling product is optional.

## 6. Product constraints

Everything is a plugin except the minimal contracts/bootstrap. TypeScript is the implementation direction; Python Pipecat can be a reference benchmark, not an unannounced production dependency. LiveKit is optional and evaluated, not mandatory. Do not rebuild codecs, WebRTC servers, or VAD models without a demonstrated requirement and decision record.

Everything that implements an application capability, including the conversation engine, is a plugin. ECS Fargate is the primary production profile; its scaling and lifecycle requirements are specified in [the deployment mandate](08-plugin-first-fargate.md). One active call per worker initially. Single EC2 can host multiple worker containers. SQS queues jobs, never realtime audio. Shared services may be always on; zero-idle worker economics are a planning scenario, not an infrastructure guarantee.

Account for all attempted calls, transfers, retries, provider usage and shared costs. ₹10 for two minutes is a configurable pricing scenario, not proof of margin. No universal legal-compliance claim; deployer configures calling/recording/retention policy appropriate to the deployment.
