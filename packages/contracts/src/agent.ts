import { z } from 'zod';
import {
  AgentEnding,
  AgentOpening,
  AgentVoicemail,
  END_CALL_TOOL_ID,
} from './agent-call-control.ts';
import { AgentDecisionPolicy } from './agent-decision.ts';
import { AgentKnowledgePolicy } from './agent-knowledge.ts';
import { AgentDecisionUnavailable, AgentIdle, AgentRecovery } from './agent-recovery.ts';
import { AgentRules, ruleDecisionTarget } from './agent-rules.ts';
import { ScriptGraph } from './script.ts';
import { AgentVoice } from './selection.ts';

// Wave 3 agent blocks live in their own modules and are re-exported here, beside the config.
export * from './agent-recovery.ts';
export * from './agent-rules.ts';
export * from './agent-jev-only.ts';

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;
export const Mode = z.enum(['announcement', 'faq', 'context', 'agent']);
export type Mode = z.infer<typeof Mode>;
export const ProcessingSpeech = z.object({
  initial: z.string().min(1).max(1000),
  progress: z.string().max(1000).optional(),
  progressAfterMs: z.number().int().positive().default(5000),
  maxProgress: z.number().int().min(0).max(3).default(1),
  failure: z.string().min(1).default('I could not complete that check.'),
});
export type ProcessingSpeech = z.infer<typeof ProcessingSpeech>;
export const ToolDefinition = z.object({
  id: z.string().min(1).max(120),
  description: z.string().max(2000),
  connector: z.enum(['native', 'http', 'mcp']),
  connectionId: z.string().optional(),
  remoteName: z.string().optional(),
  inputSchema: JsonSchema,
  outputSchema: JsonSchema.optional(),
  schemaDigest: z.string().optional(),
  effect: z.enum(['read', 'write']),
  confirmation: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(120000).default(10000),
  processing: ProcessingSpeech.optional(),
  http: z
    .object({
      endpoint: z
        .url()
        .max(2048)
        .refine((value) => {
          try {
            const url = new URL(value);
            return !url.username && !url.password;
          } catch {
            return false;
          }
        }, 'HTTP endpoint cannot contain credentials; use credentialId'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
      credentialId: z.string().min(1).optional(),
      idempotencyHeader: z.string().max(100).optional(),
      responseType: z.enum(['json', 'text']).default('json'),
      responsePointer: z.string().max(500).optional(),
    })
    .strict()
    .optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;
export const AgentConfig = z
  .object({
    name: z.string().min(1).max(120),
    mode: Mode,
    language: z.string().default('en-IN'),
    locale: z.string().default('en-IN'),
    timezone: z.string().default('Asia/Kolkata'),
    message: z.string().max(20000).default(''),
    variables: JsonSchema.default({ type: 'object', properties: {}, additionalProperties: false }),
    faq: z
      .array(
        z.object({
          id: z.string(),
          question: z.string(),
          aliases: z.array(z.string()).default([]),
          answer: z.string(),
          requiresTool: z.string().optional(),
          toolInput: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(1000)
      .default([]),
    faqThreshold: z.number().min(0).max(1).default(0.65),
    script: ScriptGraph.optional(),
    /** Per-agent decision questions, answered by the selected `decision` plugin (§P1). */
    decision: AgentDecisionPolicy.optional(),
    /** Per-agent grounding, retrieved from the selected `knowledge` plugin. */
    knowledge: AgentKnowledgePolicy.optional(),
    /** Agent mode only: spoken first, before the caller says anything (greet-first). */
    opening: AgentOpening.optional(),
    /** Agent mode only: answering-machine handling on outbound calls. */
    voicemail: AgentVoicemail.optional(),
    /** Agent mode only: how the agent may end the call itself. */
    ending: AgentEnding.optional(),
    /** Agent mode only: the instant rules tier, matched before the decision model (AGT-6). */
    rules: AgentRules.optional(),
    /** Agent mode only: escalating lines when the caller goes silent, then a closing line (AGT-11). */
    idle: AgentIdle.optional(),
    /** Agent mode only: repeat, didn't-catch and re-ask lines, bounded (AGT-12). */
    recovery: AgentRecovery.optional(),
    /** Agent mode only: what the caller hears when the decision model is unavailable (AGT-4). */
    decisionUnavailable: AgentDecisionUnavailable.optional(),
    faqMargin: z.number().min(0).max(1).default(0.15),
    clarification: z.string().default('Please clarify your question.'),
    context: z.string().max(100000).default(''),
    contextBudget: z.number().int().min(1).max(100000).default(12000),
    uncertainty: z.string().default('I do not have that information.'),
    tools: z.array(ToolDefinition).max(100).default([]),
    allowedTools: z.array(z.string()).default([]),
    processing: ProcessingSpeech.default({
      initial: 'Please wait while I check that.',
      progressAfterMs: 5000,
      maxProgress: 1,
      failure: 'I could not complete that check.',
    }),
    maxSteps: z.number().int().min(1).max(20).default(5),
    /** Legacy provider bindings, kept exactly as they are. `session-host` maps them to `voice` (§4.1). */
    providers: z.record(z.string(), z.string()).default({}),
    /** Per-agent plugin selection (§4.1). Missing slots are filled from the distribution defaults. */
    voice: AgentVoice.optional(),
    recording: z.boolean().default(false),
    speechCache: z
      .object({
        enabled: z.boolean(),
        announcement: z.boolean().optional(),
      })
      .strict()
      .optional(),
    costPolicy: z
      .object({
        budgetId: z.string().min(1).max(200),
        reservationPaise: z.string().regex(/^[1-9][0-9]{0,59}$/),
        maxCallSeconds: z.number().int().min(1).max(14400),
        priceCards: z
          .record(
            z.string(),
            z
              .object({
                id: z.string().min(1).max(200),
                version: z.string().min(1).max(200),
                fxId: z.string().min(1).max(200).optional(),
                fxVersion: z.string().min(1).max(200).optional(),
              })
              .strict(),
          )
          .refine(
            (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 100,
            'Cost policy requires between 1 and 100 price references',
          ),
      })
      .strict()
      .optional(),
  })
  .refine((config) => !config.script || config.mode === 'announcement' || config.mode === 'faq', {
    message: 'Deterministic scripts require announcement or FAQ mode',
    path: ['script'],
  })
  .refine((config) => new Set(config.faq.map((entry) => entry.id)).size === config.faq.length, {
    message: 'FAQ IDs must be unique',
    path: ['faq'],
  })
  // Only the agent behaviour speaks an opening, leaves a voicemail or ends the call; on any other
  // mode these would validate and then do nothing.
  .refine((config) => config.mode === 'agent' || !config.opening, {
    message: 'An opening requires agent mode',
    path: ['opening'],
  })
  .refine((config) => config.mode === 'agent' || !config.voicemail, {
    message: 'A voicemail policy requires agent mode',
    path: ['voicemail'],
  })
  .refine((config) => config.mode === 'agent' || !config.ending, {
    message: 'An ending policy requires agent mode',
    path: ['ending'],
  })
  .refine(
    (config) =>
      !config.ending?.llmTool || !config.tools.some((tool) => tool.id === END_CALL_TOOL_ID),
    { message: `Tool id ${END_CALL_TOOL_ID} is reserved for ending the call`, path: ['tools'] },
  )
  .superRefine((config, ctx) => {
    for (const field of ['rules', 'idle', 'recovery', 'decisionUnavailable'] as const)
      if (config[field] && config.mode !== 'agent')
        ctx.addIssue({ code: 'custom', message: `${field} requires agent mode`, path: [field] });
    // Rules, re-asks and the unavailable line all route through the decision policy; without one
    // they would validate and never run.
    const questions = config.decision?.enabled ? config.decision.questions : undefined;
    for (const field of ['rules', 'decisionUnavailable'] as const)
      if (config[field] && !questions)
        ctx.addIssue({
          code: 'custom',
          message: `${field} needs an enabled decision policy`,
          path: [field],
        });
    for (const key of Object.keys(config.recovery?.reprompts ?? {}))
      if (!questions?.some((question) => question.id === key))
        ctx.addIssue({
          code: 'custom',
          message: `Re-ask ${key} names no decision question`,
          path: ['recovery', 'reprompts', key],
        });
    if (!questions) return;
    config.rules?.global.forEach((rule, index) => {
      const problem = flatRuleTarget(rule.intent, questions);
      if (problem)
        ctx.addIssue({ code: 'custom', message: problem, path: ['rules', 'global', index] });
    });
    if (config.rules && Object.keys(config.rules.listens).length)
      ctx.addIssue({
        code: 'custom',
        message: 'Listen-set rules need a flow; use global rules for a decision policy',
        path: ['rules', 'listens'],
      });
  });

/** Why a flat agent's rule target does not name an answer its decision policy offers. */
function flatRuleTarget(
  intent: string,
  questions: NonNullable<z.infer<typeof AgentDecisionPolicy>['questions']>,
): string | undefined {
  const target = ruleDecisionTarget(intent);
  if (!target) return `Rule ${intent} must name <question>=<answer> without a flow`;
  const question = questions.find((candidate) => candidate.id === target.question);
  if (!question) return `Rule ${intent} names no decision question`;
  const answers =
    question.type === 'choice'
      ? question.options.map((option) => option.key)
      : question.type === 'noul'
        ? ['yes', 'no']
        : [];
  return answers.includes(target.answer)
    ? undefined
    : `Rule ${intent} names no answer of ${question.id}`;
}

export type AgentConfig = z.infer<typeof AgentConfig>;
