# OVO behavior integration contract

The package exports one plugin factory per agent mode. Select exactly one behavior plugin in a session composition; every factory provides the exclusive `ovo.behavior` service.

```ts
import {
  BEHAVIOR_PLUGIN_IDS,
  createAgentBehaviorPlugin,
  createAnnouncementBehaviorPlugin,
  createContextBehaviorPlugin,
  createFaqBehaviorPlugin,
} from '@winsendotai/ovo-behaviors';

const catalog = [
  createAnnouncementBehaviorPlugin(),
  createFaqBehaviorPlugin(),
  createContextBehaviorPlugin(),
  createAgentBehaviorPlugin(),
];

const rows = [
  {
    id: BEHAVIOR_PLUGIN_IDS.announcement,
    config: { agent },
  },
];
```

Stable plugin IDs are exported as `BEHAVIOR_PLUGIN_IDS`; callers should not duplicate string literals. Simulated bootstrap code can combine `createBehaviorPluginCatalog()`, `createSimulatedInferencePlugin()`, and `createSimulatedVoicePluginCatalog()` from the three packages, then select one behavior row by mode. The simulated adapters are labelled and make no network or provider calls.

All behavior plugin configs use this shape:

```ts
interface BehaviorPluginConfig {
  agent: AgentConfig;
  workspaceId?: string; // required by agent mode
  sessionId?: string; // required by agent mode
}
```

## Service dependencies

| Factory                              | Requires                         | Provides       | Model use                   |
| ------------------------------------ | -------------------------------- | -------------- | --------------------------- |
| `createAnnouncementBehaviorPlugin()` | none                             | `ovo.behavior` | never                       |
| `createFaqBehaviorPlugin()`          | none                             | `ovo.behavior` | never                       |
| `createContextBehaviorPlugin()`      | `ovo.inference`                  | `ovo.behavior` | one request per response    |
| `createAgentBehaviorPlugin()`        | `ovo.inference`, `ovo.execution` | `ovo.behavior` | bounded by `agent.maxSteps` |

The agent behavior calls business operations only through the shared `Execution` contract exposed as `ovo.execution`. It never imports or invokes a connector or provider SDK. `variables.confirmed === true` is forwarded as the current confirmation signal; the execution service remains the policy and durable-intent authority.

Direct constructors (`createAnnouncementBehavior`, `createFaqBehavior`, `createContextBehavior`, and `createAgentBehavior`) are also exported for previews and focused tests. Announcement helpers validate variables with Ajv before safe path-only rendering. Supported formatting metadata is JSON Schema `format: "date" | "date-time" | "time"` and `x-ovo-format: "currency"` with `x-ovo-currency`.

The current shared `Behavior` contract returns only text, so confirmation prompts, transitions, and end/transfer actions cannot yet be represented as structured actions. The package rejects unsafe/unknown operations and exposes richer local diagnostics without pretending the shared contract carries those actions.
