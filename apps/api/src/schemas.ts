import { z } from 'zod';
import { AgentConfig } from '@winsendotai/ovo-contracts';
export const Id = z.string().uuid();
export const PluginSelection = z.array(z.string().min(1)).min(1).max(50);
export const AgentBody = z.object({ config: AgentConfig });
export const CredentialBody = z.object({
  label: z.string().min(1).max(120),
  provider: z.string().min(1).max(120),
  type: z.string().min(1).max(120),
  environment: z.string().min(1).max(120),
  value: z.string().min(1).max(100_000),
  expiresAt: z.iso.datetime().nullable().optional(),
  permittedAgentIds: z.array(Id).max(100).default([]),
});
export const ProviderBindingBody = z.object({
  label: z.string().min(1).max(120),
  provider: z.string().min(1).max(120),
  environment: z.string().min(1).max(120),
  credentialId: Id,
  config: z.record(z.string(), z.unknown()).default({}),
});
export const McpBody = z.object({
  label: z.string().min(1).max(120),
  endpoint: z.url(),
  auth: z.enum(['none', 'bearer']),
  credentialId: Id.nullable().optional(),
});
export const ApprovalBody = z.object({
  connectionId: Id,
  remoteName: z.string().min(1).max(240),
  schemaDigest: z.string().min(8).max(256),
});
export const SimulationBody = z.object({
  releaseId: Id,
  input: z.string().min(1).max(20_000),
  variables: z.record(z.string(), z.unknown()).default({}),
});
export const EvaluationBody = z.object({
  releaseId: Id,
  fixtures: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        input: z.string().min(1).max(20_000),
        variables: z.record(z.string(), z.unknown()).default({}),
        expectedOutput: z.string().optional(),
        forbiddenOutput: z.array(z.string()).max(100).default([]),
      }),
    )
    .min(1)
    .max(100),
});
export const UsageBody = z.object({
  id: Id,
  provider: z.string().min(1),
  providerRequestId: z.string().min(1),
  quantity: z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,12})?$/),
  unit: z.string().min(1),
  state: z.enum(['estimated', 'reconciled']),
  priceCard: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    provider: z.string().min(1),
    unit: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnitsPerBlock: z.string(),
    blockQuantity: z.string(),
  }),
});
