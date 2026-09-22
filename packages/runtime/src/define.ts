import type { Context } from '@deepseek-ai/cordis';
import {
  Manifest,
  type CapabilityMap,
  type CapKey,
  type ManifestInput,
  type ManifestV2Input,
  type NetPort,
} from '@winsendotai/ovo-contracts';

export interface PluginDefinition {
  manifest: Manifest;
  /** Receives the guarded facade (§3.3), which is also a Cordis `Context` at run time. */
  apply: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}

export interface PluginRow {
  id: string;
  config?: Record<string, unknown>;
}

/** The interface registered under capability key `K`, or `unknown` for keys contracts do not type. */
export type CapabilityOf<K extends string> = K extends CapKey ? CapabilityMap[K] : unknown;

/** The guarded context every plugin's `apply` receives (§3.3). Host code keeps the raw `composition.ctx`. */
export interface PluginContext<R extends string = string, P extends string = string> {
  /** Throws when the capability is absent (v2); v1 plugins keep Cordis semantics (undefined). */
  get<K extends R>(key: K): CapabilityOf<K>;
  maybe<K extends R>(key: K): CapabilityOf<K> | undefined;
  /** For cardinality 'many': a frozen map keyed by provider. */
  all<K extends R>(key: K): ReadonlyMap<string, CapabilityOf<K>>;
  provide<K extends P>(key: K, value: CapabilityOf<K>): () => void;
  /** Resolves `{credentialRef:{credentialId}}` at `pointer` in row config via `ovo.secret-resolver`. */
  secret(pointer: string): Promise<string>;
  /** The host `ovo.net`, filtered by `manifest.runtime.egressHosts` (https and wss only). */
  readonly net: NetPort;
  effect: Context['effect'];
  on: Context['on'];
  fiber: Context['fiber'];
  reflect: Context['reflect'];
}

type EntryKey<E> = E extends `${infer K}@${number}` ? K : E;
type Elements<T> = T extends readonly (infer E)[] ? E : never;
type Field<M, F extends string> = M extends { readonly [P in F]?: infer V } ? V : never;
/** Keys a manifest may read: `requires ∪ optional`, with any `@major` suffix removed. */
export type ReqOf<M> = EntryKey<Elements<Field<M, 'requires'>> | Elements<Field<M, 'optional'>>> &
  string;
/** Keys a manifest may provide, with any `@major` suffix removed. */
export type ProvOf<M> = EntryKey<Elements<Field<M, 'provides'>>> & string;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
/** A v2 manifest literal, written inline or `as const`. */
export type ManifestV2Literal = DeepReadonly<ManifestV2Input>;

/** v2 manifests get a typed context: `get`/`provide` are checked against `requires`/`provides`. */
export function definePlugin<const M extends ManifestV2Literal>(
  manifest: M,
  apply: (
    ctx: PluginContext<ReqOf<M>, ProvOf<M>>,
    config: Record<string, unknown>,
  ) => void | Promise<void>,
): PluginDefinition;
/** Plain-string form. Declared LAST: `Parameters<typeof definePlugin>` resolves to this overload. */
export function definePlugin(
  manifest: Manifest,
  apply: PluginDefinition['apply'],
): PluginDefinition;
export function definePlugin(
  manifest: ManifestInput | ManifestV2Literal,
  apply: (ctx: never, config: Record<string, unknown>) => void | Promise<void>,
): PluginDefinition {
  return { manifest: Manifest.parse(manifest), apply: apply as PluginDefinition['apply'] };
}
