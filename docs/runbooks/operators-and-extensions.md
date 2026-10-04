# Operators and installed extensions

Each installation serves one organization. `workspaceId` is an internal compatibility and authorization namespace, not a tenant-provisioning interface.

## Team users

New installations use email/password sign-in and a flat user list. There are no subteams, invitations, or organization switching.

1. Follow [the Compose setup guide](self-hosted-compose.md) to seed the first administrator.
2. Sign in with the configured administrator email and password.
3. Open **Team**.
4. Add a user with a name, email, initial password, and **User** or **Admin** role.
5. Give the initial password to the user through a private channel.

Multiple administrators can coexist. An administrator can reset passwords, change roles, disable accounts, and enable accounts. The API prevents disabling or demoting the last active administrator. User changes invalidate that user's existing sessions. Users can change their own password with their current password; this requires a new sign-in.

Passwords require 12–128 characters. The database stores salted scrypt hashes, not plaintext passwords. The console never receives those hashes. Login has bounded per-process rate limits and bounded hashing work; use a shared edge rate limit when running multiple API replicas. The installation supports up to 500 users.

Seeding is idempotent: a normal restart never resets an existing user's password or recreates an administrator. Keep `OVO_SESSION_SECRET` and the credential-encryption key stable and private. [Restore recovery](backup-restore.md) requires explicit administrator recovery and new passwords, not ordinary seed replay.

The **User** label maps to the existing `editor` permission: users can author agents and run permitted workflows, but cannot administer users or credentials. **Admin** has installation administration permissions. The API remains the authorization boundary.

## Legacy token operators

Token operators remain available for compatibility and controlled automation; new team members do not need environment-variable entries. An installation that only seeds email/password users has no enabled implicit bootstrap-token account.

The legacy bootstrap administrator uses `OVO_ADMIN_TOKEN`. Use at least 32 random characters in production. Supply secrets through the deployment secret mechanism, not Git or frontend configuration.

Declare additional operators with metadata only:

```sh
OVO_OPERATORS_JSON='[{"id":"auditor","label":"Auditor","role":"viewer","tokenEnv":"OVO_OPERATOR_AUDITOR_TOKEN"}]'
```

Set `OVO_OPERATOR_AUDITOR_TOKEN` separately to a distinct random credential. The API accepts `viewer`, `editor`, and `admin` roles. Every configured operator uses the bootstrap administrator's organization namespace. Duplicate operator IDs and credentials fail startup.

- Viewers inspect records and evidence.
- Editors author drafts and run authorized simulations/evaluations.
- Administrators manage credentials, cost policies, live admission, and destructive lifecycle actions.

The API enforces each route's role requirement. A hidden console button is not an authorization boundary.

Restart the API after operator configuration changes. Removing an operator revokes that operator's sessions. Rotating an operator credential also revokes existing sessions, even when the installation session-signing secret stays unchanged. Role changes apply when the API next validates the session.

Old cookies created before credential-version binding require a new login.

## Safe simulations

The console defaults to explicit fixture bindings. A simulation request can provide:

```json
{
  "releaseId": "<immutable-release-uuid>",
  "input": "Check the fixture",
  "bindings": {
    "modelReplies": [{ "kind": "text", "text": "Fixture response" }],
    "toolResults": { "lookup": { "fixture": true } }
  }
}
```

Fixture bindings replace inference and tool connector initialization. They do not contact model providers, carrier APIs, or business systems. Missing model replies return the configured uncertainty response. Missing tool results fail the simulated tool execution.

Provider-backed simulations omit `bindings`. They can incur model charges and execute approved read tools. The API rejects this mode if the release permits a write tool. Simulation call events identify the binding mode. Do not treat simulated results as completed business actions.

## Installed native extensions

Build and install extension packages in the API and worker images. No runtime package download occurs.

```sh
OVO_PLUGIN_MODULES='["@example/ovo-business-tools"]'
```

Each package can export `plugins` (ordinary OVO plugin definitions). A package that provides native handlers must export an explicitly identified, versioned bundle:

```js
export const nativeHandlers = {
  package: { name: '@example/ovo-business-tools', version: '1.2.3' },
  plugin: {
    id: '@example/ovo-business-tools/native-handlers',
    version: '1.2.3',
  },
  handlers: {
    lookup: async (input, context) => ({ result: 'operator implementation' }),
  },
};
```

The package name must exactly match its `OVO_PLUGIN_MODULES` entry. The marker plugin ID must be `<package-name>/native-handlers`, and its version must exactly match the package version. Versions use `major.minor.patch`; increment the version whenever handler behavior or dependencies change. Handlers receive approved inputs and the shared execution context. They must honor cancellation and provider idempotency requirements.

The loader accepts installed package identifiers only. It rejects URLs, file paths, unversioned or mismatched native bundles, malformed definitions, duplicate plugin IDs, and duplicate handler IDs. Operator-approved package code is trusted server code; this is not a sandbox for customer-authored JavaScript.

The API adds a session-scoped marker plugin for every native-handler package used by an agent. The native connector requires those marker services, so default release graph resolution stores exact marker IDs and versions in the immutable release. API simulations and workers reconstruct the graph from their installed registries and reject a release when its marker is missing or has a different version. An old release therefore cannot silently run updated handler code.

Pass all three loader outputs through unchanged in both API and worker composition:

```ts
const extensions = await loadInstalledSessionExtensions(process.env.OVO_PLUGIN_MODULES);

// Global approved catalog.
pluginCatalog: extensions.plugins;

// Per-session factory input.
nativeHandlers: extensions.nativeHandlers;
nativeHandlerPackages: extensions.nativeHandlerPackages;
```

Keep the same installed package versions in API and worker images. Removing a package or changing its version intentionally makes older dependent releases unavailable until their exact pinned implementation is restored or a new release is published.
