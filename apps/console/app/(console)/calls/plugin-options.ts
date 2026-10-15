import { apiRequest } from '../../../lib/api';

export interface PluginOption {
  id: string;
  label: string;
}

/** Engine/carrier Select options: value is the plugin id, label is its `ui.label` (brief §3
 * CALLS) — never a hardcoded vendor name or colour. */
export async function loadPluginOptions(kind: 'engine' | 'carrier'): Promise<PluginOption[]> {
  const { data } = await apiRequest<{ plugins: { id: string; ui?: { label?: string } }[] }>(
    `/plugins?kind=${kind}`,
  );
  return data.plugins.map((plugin) => ({ id: plugin.id, label: plugin.ui?.label ?? plugin.id }));
}
