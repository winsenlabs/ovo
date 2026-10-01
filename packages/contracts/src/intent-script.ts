import { z } from 'zod';

/**
 * Future voice script router. The ASK / CLASSIFY / KNOWN steps and attribute-key rules follow
 * OCSO's pure, versioned RouterStep model in packages/domain/src/routing/router-definition.ts.
 * This is a contract only; the current literal ScriptGraph remains executable until a later unit.
 */
const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const AttributeKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Label = z.string().trim().min(1).max(60);
const Description = z.string().trim().min(1).max(2_000);
const MessageSpec = z
  .object({
    text: z.string().trim().min(1).max(1_000),
    templates: z.record(z.uuid(), z.uuid()).optional(),
  })
  .strict();

export const IntentRouterStep = z.discriminatedUnion('kind', [
  z
    .object({
      id: NodeId,
      kind: z.literal('ASK'),
      attribute: AttributeKey,
      prompt: MessageSpec,
      options: z
        .array(
          z
            .object({
              value: Label,
              label: Label,
              synonyms: z.array(Label).max(20).optional(),
            })
            .strict(),
        )
        .min(2)
        .max(10),
      maxAttempts: z.number().int().min(1).max(5),
      skipIfKnown: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: NodeId,
      kind: z.literal('CLASSIFY'),
      attribute: AttributeKey,
      modelProfileId: z.string().min(1),
      instructions: z.string().trim().max(4_000),
      labels: z
        .array(z.object({ value: Label, description: z.string().trim().max(500) }).strict())
        .min(2)
        .max(20),
      minConfidence: z.number().min(0).max(1),
      maxFollowUps: z.number().int().min(0).max(3),
      skipIfKnown: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: NodeId,
      kind: z.literal('KNOWN'),
      attribute: AttributeKey,
      from: z.union([
        z.literal('customer.language'),
        z.string().regex(/^customer\.attribute:[A-Za-z0-9_.-]{1,60}$/),
      ]),
    })
    .strict(),
]);
export type IntentRouterStep = z.infer<typeof IntentRouterStep>;

export const IntentDefinition = z
  .object({
    id: NodeId,
    description: Description,
    /** A caller below this calibrated threshold must take the fallback path. */
    minConfidence: z.number().min(0).max(1),
    slots: z.array(AttributeKey).max(20).default([]),
  })
  .strict();
export type IntentDefinition = z.infer<typeof IntentDefinition>;

/** All `when` attributes must match; an array accepts any one of its values. */
const SlotCondition = z.record(AttributeKey, z.union([Label, z.array(Label).min(1).max(20)]));

export const IntentScriptNode = z
  .object({
    id: NodeId,
    prompt: Description,
    terminal: z.boolean(),
    steps: z.array(IntentRouterStep).max(10),
    intents: z.array(IntentDefinition).max(30),
    routes: z
      .array(
        z
          .object({
            intentId: NodeId,
            when: SlotCondition,
            to: NodeId,
          })
          .strict(),
      )
      .max(100),
    fallback: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('llm'), resumeAt: NodeId }).strict(),
        z.object({ kind: z.literal('node'), to: NodeId }).strict(),
      ])
      .optional(),
  })
  .strict();
export type IntentScriptNode = z.infer<typeof IntentScriptNode>;

export const IntentScriptGraph = z
  .object({
    version: z.literal(1),
    start: NodeId,
    maxVisits: z.number().int().min(1).max(100),
    /** Evaluated at every node before node-local intents. */
    globalIntents: z.array(IntentDefinition).max(30),
    nodes: z.array(IntentScriptNode).min(1).max(100),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (ids.size !== graph.nodes.length) fail(['nodes'], 'Intent node IDs must be unique');
    if (!ids.has(graph.start)) fail(['start'], 'Intent start node does not exist');
    const globalIds = graph.globalIntents.map((intent) => intent.id);
    if (new Set(globalIds).size !== globalIds.length)
      fail(['globalIntents'], 'Global intent IDs must be unique');
    graph.nodes.forEach((node, index) => {
      const path = ['nodes', index];
      const stepIds = node.steps.map((step) => step.id);
      if (new Set(stepIds).size !== stepIds.length)
        fail([...path, 'steps'], 'Router step IDs must be unique within a node');
      node.steps.forEach((step, stepIndex) => {
        const values =
          step.kind === 'ASK'
            ? step.options.map((option) => option.value.trim().toLowerCase())
            : step.kind === 'CLASSIFY'
              ? step.labels.map((label) => label.value.trim().toLowerCase())
              : [];
        if (new Set(values).size !== values.length)
          fail([...path, 'steps', stepIndex], 'Router option values must be unique');
        if (step.kind === 'ASK') {
          const labels = step.options.map((option) => option.label.trim().toLowerCase());
          if (new Set(labels).size !== labels.length)
            fail([...path, 'steps', stepIndex], 'Router option labels must be unique');
        }
      });
      const intentIds = [...globalIds, ...node.intents.map((intent) => intent.id)];
      if (new Set(intentIds).size !== intentIds.length)
        fail([...path, 'intents'], 'Node intent IDs must not shadow global or local intents');
      const attributes = new Set([
        ...node.steps.map((step) => step.attribute),
        ...graph.globalIntents.flatMap((intent) => intent.slots),
        ...node.intents.flatMap((intent) => intent.slots),
      ]);
      if (node.terminal && (node.routes.length || node.fallback))
        fail(path, 'Terminal intent nodes cannot route onward');
      if (!node.terminal && !node.fallback)
        fail([...path, 'fallback'], 'Nonterminal intent nodes need a fallback');
      node.routes.forEach((route, routeIndex) => {
        const routePath = [...path, 'routes', routeIndex];
        if (!intentIds.includes(route.intentId))
          fail([...routePath, 'intentId'], 'Route references an unknown intent');
        if (!ids.has(route.to)) fail([...routePath, 'to'], 'Route target does not exist');
        for (const attribute of Object.keys(route.when))
          if (!attributes.has(attribute))
            fail([...routePath, 'when', attribute], 'Route condition uses an unextracted slot');
      });
      if (node.fallback?.kind === 'llm' && !ids.has(node.fallback.resumeAt))
        fail([...path, 'fallback', 'resumeAt'], 'LLM fallback resume node does not exist');
      if (node.fallback?.kind === 'node' && !ids.has(node.fallback.to))
        fail([...path, 'fallback', 'to'], 'Fallback node does not exist');
    });
  });
export type IntentScriptGraph = z.infer<typeof IntentScriptGraph>;
