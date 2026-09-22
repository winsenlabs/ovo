import { Context } from '@deepseek-ai/cordis';
import { Cap, type NetPort, type SecretResolver } from '@winsendotai/ovo-contracts';
import { isCredentialReference, readPointer } from './config-guard.ts';
import type { PluginContext, PluginDefinition } from './define.ts';
import type { EnforcementMode, ViolationKind, ViolationLog } from './enforcement.ts';
import { isMany, manifestKeys, qualifierOf } from './graph.ts';
import { isEngineToolKey } from './kind-rules.ts';
import { filteredNet } from './net-guard.ts';
import { frozenMap, qualifiedServices, type ParentView } from './scope.ts';

export interface FacadeOptions {
  definition: PluginDefinition;
  config: Record<string, unknown>;
  mode: EnforcementMode;
  log: ViolationLog;
  parent?: ParentView;
  /** Keys this plugin may read from the parent (declared, provided there, not session-scoped). */
  parentReadable: ReadonlySet<string>;
  net?: NetPort;
  workspaceId?: string;
}

export type GuardedContext = Context & PluginContext;

const CONTEXT_METHODS = new Set<PropertyKey>(Reflect.ownKeys(Context.prototype));

/**
 * The Proxy each `apply` receives (§3.3). Declared reads and provides pass through to the plugin's
 * own Cordis root, declared parent keys delegate to the parent, and everything else is recorded
 * (warn) or thrown (enforce). Egress denial and engine tool access always throw.
 */
export function createFacade(ctx: Context, options: FacadeOptions): GuardedContext {
  const { definition, mode, log, parent } = options;
  const keys = manifestKeys(definition.manifest);
  const { manifest } = keys;
  const legacy = definition.manifest.contractVersion === 1;
  const readable = new Set(
    [...keys.requires, ...keys.optional, ...keys.provides].map((e) => e.key),
  );
  const providable = new Set(keys.provides.map((entry) => entry.key));
  const report = (kind: ViolationKind, key: string, message?: string) =>
    log.report({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      kind,
      key,
      mode,
      message,
    });
  const guardEngine = (key: string) => {
    if (manifest.kind === 'engine' && isEngineToolKey(key))
      report('engine-tool-access', key, `engine-tool-access: engine ${manifest.id} touched ${key}`);
  };
  const guardRead = (key: string) => {
    guardEngine(key);
    if (!readable.has(key))
      report('read-undeclared', key, `read-undeclared: ${manifest.id} read ${key}`);
  };
  const guardProvide = (key: string) => {
    guardEngine(key);
    if (!providable.has(key))
      report('provide-undeclared', key, `provide-undeclared: ${manifest.id} provided ${key}`);
  };
  const serviceName = (key: string) => (isMany(key) ? `${key}:${qualifierOf(manifest)}` : key);
  const lookup = (key: string, strict?: boolean): unknown => {
    if (isMany(key)) throw new Error(`${key} has cardinality many; read it with ctx.all()`);
    // A plugin's own services are not active until its apply returns; read those non-strictly.
    const local = ctx.get(key, providable.has(key) ? false : strict);
    if (local !== undefined) return local;
    return parent && options.parentReadable.has(key) ? parent.get(key) : undefined;
  };
  const all = (key: string): ReadonlyMap<string, unknown> => {
    guardRead(key);
    if (!isMany(key)) {
      const value = lookup(key);
      return frozenMap(value === undefined ? [] : [[key, value] as const]);
    }
    const inherited = parent && options.parentReadable.has(key) ? parent.all(key) : new Map();
    return frozenMap([...inherited, ...qualifiedServices(ctx, key)]);
  };
  const provide = (key: string, value?: unknown) => {
    guardProvide(key);
    return ctx.provide(serviceName(key), value);
  };
  let net: NetPort | undefined;
  const hostNet = () =>
    options.net ??
    ((parent?.keys.has(Cap.net) ? parent.get(Cap.net) : undefined) as NetPort | undefined) ??
    (ctx.get(Cap.net) as NetPort | undefined);
  const secret = async (pointer: string): Promise<string> => {
    const reference = readPointer(options.config, pointer);
    if (!isCredentialReference(reference))
      throw new Error(`${manifest.id}: config ${pointer || '/'} holds no {credentialRef}`);
    if (!options.workspaceId) throw new Error(`${manifest.id}: ctx.secret needs a workspaceId`);
    const resolver = (ctx.get(Cap.secrets) ??
      (parent?.keys.has(Cap.secrets) ? parent.get(Cap.secrets) : undefined)) as
      SecretResolver | undefined;
    if (!resolver) throw new Error(`${manifest.id}: ${Cap.secrets} is not available`);
    return resolver.resolve(options.workspaceId, reference.credentialRef.credentialId);
  };
  const reflect = new Proxy(ctx.reflect, {
    get(target, prop) {
      if (prop === 'get')
        return (key: string, strict?: boolean) => {
          guardRead(key);
          return lookup(key, strict);
        };
      if (prop === 'provide') return provide;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const overrides: Record<string, unknown> = {
    get(key: string, strict?: boolean) {
      guardRead(key);
      const value = lookup(key, strict);
      if (value === undefined && !legacy)
        throw new Error(`Missing capability ${key} for ${manifest.id}`);
      return value;
    },
    maybe(key: string) {
      guardRead(key);
      return lookup(key);
    },
    all,
    provide,
    set(key: string, value: unknown) {
      guardProvide(key);
      return ctx.set(serviceName(key), value);
    },
    secret,
    reflect,
  };
  return new Proxy(Object.create(null) as GuardedContext, {
    get(_target, prop) {
      if (prop === 'net') return (net ??= filteredNet(hostNet, manifest, report));
      if (typeof prop === 'string' && Object.hasOwn(overrides, prop)) return overrides[prop];
      const value: unknown = Reflect.get(ctx, prop);
      return typeof value === 'function' && CONTEXT_METHODS.has(prop) ? value.bind(ctx) : value;
    },
    has(_target, prop) {
      return prop === 'net' || (typeof prop === 'string' && prop in overrides) || prop in ctx;
    },
    set(_target, prop, value) {
      return Reflect.set(ctx, prop, value);
    },
  });
}
