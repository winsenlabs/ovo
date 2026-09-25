import { apiRequest } from '../api';
import type { PluginCatalog } from '../../components/plugins/types';
export const resources = {
  plugins: async () => (await apiRequest<PluginCatalog>('/plugins')).data,
  bindings: async () => (await apiRequest<{ items: unknown[] }>('/provider-bindings')).data,
  agents: async () => (await apiRequest<{ items: unknown[]; nextCursor?: string }>('/agents?limit=50')).data,
};
