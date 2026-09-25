import type { AgentVoice, CompatIssue, Slot } from '@winsendotai/ovo-contracts';
export type { AgentVoice, CompatIssue, Slot };
export type PluginOption = {
  id: string; version: string; kind: string; provider?: string; available: boolean;
  unavailableReason?: string; capabilities?: Record<string, unknown>;
  configSchema?: JsonShape; bindingSchema?: JsonShape; secretFields?: string[];
  meters?: { key: string; label: string; unit: string }[];
  ui?: { label?: string; description?: string; vendor?: string; fields?: Record<string, { widget?: string; label?: string; help?: string; advanced?: boolean }> };
};
export type JsonShape = { type?: string; properties?: Record<string, JsonShape>; required?: string[]; enum?: unknown[]; const?: unknown; minimum?: number; maximum?: number; default?: unknown; description?: string };
export type PluginCatalog = { plugins: PluginOption[]; unavailable?: { id: string; reason: string }[] };
export const SLOT_KIND: Record<Slot, string> = { engine: 'engine', carrier: 'carrier', stt: 'stt', tts: 'tts', llm: 'llm', vad: 'vad', turnDetector: 'turn-detector', audioFilter: 'audio-filter' };
