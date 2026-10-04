// The §13 package-kind table: which kinds of import each package kind may make.
import { builtinModules } from 'node:module';

const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));
const VENDOR_BANNED_NODE = new Set(['net', 'tls', 'http', 'https', 'dgram', 'http2']);
const PLUGIN_KINDS = new Set(['plugin', 'vendor-plugin', 'legacy']);
const CORE = new Set(['contracts', 'runtime', 'sdk', 'kit']);

/** session-host may also import these plugin packages (§13 table). */
const SESSION_HOST_EXTRA = new Set([
  'packages/behaviors',
  'packages/plugin-tools',
  'packages/plugin-tools-http',
  'packages/plugin-tools-mcp',
  'packages/plugin-voice',
  'packages/plugin-inference',
]);

/**
 * Classifies an import specifier: node built-in, workspace package (by name or by a relative path
 * that leaves the importing package), or third-party.
 */
export function classifyImport(specifier, { packagesByName, packageOfPath, resolveRelative }) {
  if (specifier.startsWith('.')) {
    const target = packageOfPath(resolveRelative(specifier));
    return target ? { type: 'workspace', dir: target, subpath: '' } : { type: 'local' };
  }
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const root = bare.split('/')[0];
  if (specifier.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(root))
    return { type: 'node', name: root };
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : root;
  const dir = packagesByName.get(name);
  if (dir)
    return {
      type: 'workspace',
      dir,
      name,
      subpath: specifier.slice(name.length).replace(/^\//, ''),
    };
  return { type: 'third', name };
}

/** Returns why `fromKind` may not make this import, or undefined when it may. */
export function violation(from, target, kindOf) {
  const kind = from.kind;
  if (target.type === 'local') return undefined;
  if (target.type === 'workspace' && target.dir === from.dir) return undefined;
  const targetKind = target.type === 'workspace' ? kindOf(target.dir) : undefined;
  // Vendored packages under vendor/* (cordis, cosmokit) behave like third-party code.
  const third = target.type === 'third' || (target.type === 'workspace' && targetKind === 'vendor');
  const node = target.type === 'node';
  const ws = target.type === 'workspace' && targetKind !== 'vendor';
  if (ws && targetKind === 'experiment' && kind !== 'experiment')
    return 'nothing may import an experiment';
  switch (kind) {
    case 'contracts':
      if (third && target.name === 'zod') return undefined;
      return 'contracts may import only zod';
    case 'runtime':
      if (ws && targetKind === 'contracts') return undefined;
      if (third && ['ajv', '@deepseek-ai/cordis'].includes(target.name)) return undefined;
      return 'runtime may import only cordis, contracts and ajv';
    case 'sdk':
      if (ws && ['contracts', 'runtime'].includes(targetKind)) return undefined;
      if (third && target.name === 'zod') return undefined;
      return 'sdk may import only runtime, contracts and zod';
    case 'kit':
      if (ws && targetKind === 'contracts') return undefined;
      if (third) return undefined;
      return node
        ? 'kits may not import node built-ins'
        : 'kits may import only contracts and third-party code';
    case 'test-kit':
      if (node || third) return undefined;
      if (ws && (CORE.has(targetKind) || target.dir === 'packages/behaviors')) return undefined;
      return 'conformance may import only contracts, runtime, sdk, kits and behaviors';
    case 'host':
      if (node || third) return undefined;
      if (ws && CORE.has(targetKind)) return undefined;
      if (ws && from.dir === 'packages/fixture-calls' && targetKind === 'test-kit')
        return target.subpath === 'drivers'
          ? undefined
          : 'fixture-calls may import only @winsendotai/ovo-conformance/drivers';
      if (ws && from.dir === 'packages/fixture-calls' && target.dir === 'packages/session-host')
        return undefined;
      if (ws && from.dir === 'packages/session-host' && SESSION_HOST_EXTRA.has(target.dir))
        return undefined;
      return 'host libraries may import only contracts, runtime, sdk and kits';
    case 'distribution':
      return ws && ['app', 'console'].includes(targetKind)
        ? 'distribution may not import apps'
        : undefined;
    case 'vendor-plugin':
      if (node)
        return VENDOR_BANNED_NODE.has(target.name)
          ? `vendor plugins may not import node:${target.name} (use ctx.net)`
          : undefined;
      if (third)
        return target.name === 'ws' ? 'vendor plugins may not import ws (use ctx.net)' : undefined;
      if (ws && CORE.has(targetKind)) return undefined;
      return 'vendor plugins may import only contracts, runtime, sdk and kits';
    case 'plugin':
      if (node || third) return undefined;
      if (ws && CORE.has(targetKind)) return undefined;
      return PLUGIN_KINDS.has(targetKind)
        ? 'plugins may not import another plugin or behaviors'
        : `plugins may not import ${targetKind} packages`;
    case 'legacy':
      return ws && ['app', 'console'].includes(targetKind)
        ? 'legacy packages may not import apps'
        : undefined;
    case 'app':
      if (ws && ['vendor-plugin', 'legacy'].includes(targetKind))
        return `apps may not import ${targetKind} packages`;
      if (ws && targetKind === 'test-kit') return 'apps may not import the conformance kits';
      return undefined;
    case 'console':
      if (ws && (PLUGIN_KINDS.has(targetKind) || target.dir.split('/').pop().startsWith('plugin-')))
        return 'the console may not import plugin packages';
      if (ws && ['app', 'host', 'distribution', 'test-kit'].includes(targetKind))
        return `the console may not import ${targetKind} packages`;
      return undefined;
    case 'experiment':
      return undefined;
    default:
      return `unknown package kind ${kind}`;
  }
}

export function describeTarget(target) {
  if (target.type === 'node') return `node:${target.name}`;
  if (target.type === 'workspace')
    return target.subpath ? `${target.dir}/${target.subpath}` : target.dir;
  return target.name;
}
