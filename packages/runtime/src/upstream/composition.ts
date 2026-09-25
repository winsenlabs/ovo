/** Extracted from DeepSeek Harness ddefc45fbc7f8e46dd73185e68295696d1297887.
 * vendor/include/src/index.ts and packages/boot/app-boot/src/profile.ts.
 * MIT; see LICENSE. File-backed loading and executable YAML intentionally excluded.
 */
export interface EntryOptions { id?:string; name?:string; config?:any; group?:boolean|null; disabled?:boolean|null; [key:string]:any; }
export function applyEntryPatches(
  data: EntryOptions[],
  patches: PatchOptions[] | undefined,
  warn: (message: string, ...args: any[]) => void,
): EntryOptions[] {
  if (!patches?.length) return [...data]
  data = structuredClone(data)

  const entryMap = new Map<string, EntryOptions>()
  const buildMap = (entries: EntryOptions[]) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) {
        buildMap(entry.config)
      }
    }
  }
  buildMap(data)

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) {
          warn('patch insert: entry %C not found', id)
          continue
        }
        if (!target.group) {
          warn('patch insert: entry %C is not a group', id)
          continue
        }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        data.push(...insert)
      }
      // Index what this patch added so a LATER patch in the same list can
      // target it. Patch lists compose one layer per source (each bundle
      // layer, then the user's, then `--patch` overlays), and a layer must be
      // able to configure or disable a row an earlier layer inserted; without
      // this, inserted rows were silently unpatchable.
      buildMap(insert)
      continue
    }

    if (!id) {
      warn('patch: id is required for non-insert patches')
      continue
    }

    const target = entryMap.get(id)
    if (!target) {
      warn('patch: entry %C not found', id)
      continue
    }

    if (name && name !== target.name) {
      warn('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name)
      continue
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }

  return data
}

/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}


export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
