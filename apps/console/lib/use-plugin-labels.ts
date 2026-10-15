'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from './api';

/** Plugin id -> its `/plugins` `ui.label`, for a chip that would otherwise show the raw package
 * id (inspector minor #6, e.g. "Stt: <package>@<version>" instead of the plugin's own name). */
export function usePluginLabels(): Map<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void apiRequest<{ plugins: { id: string; ui?: { label?: string } }[] }>('/plugins')
      .then(({ data }) =>
        setLabels(
          new Map(data.plugins.map((plugin) => [plugin.id, plugin.ui?.label ?? plugin.id])),
        ),
      )
      .catch(() => setLabels(new Map()));
  }, []);
  return labels;
}
