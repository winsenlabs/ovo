import { z } from 'zod';

const Transition = z
  .object({
    event: z.enum(['text', 'dtmf']),
    matches: z.array(z.string().min(1).max(200)).min(1).max(50),
    to: z.string().min(1).max(80),
  })
  .strict();

export const ScriptGraph = z
  .object({
    start: z.string().min(1).max(80),
    maxVisits: z.number().int().min(1).max(100).default(20),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            prompt: z.string().min(1).max(5000),
            terminal: z.boolean().default(false),
            transitions: z.array(Transition).max(50).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (ids.size !== graph.nodes.length) fail('Script node IDs must be unique');
    if (!ids.has(graph.start)) fail('Script start node does not exist');
    for (const node of graph.nodes) {
      const events = new Set<string>();
      if (node.terminal && node.transitions.length) fail('Terminal nodes cannot have transitions');
      for (const transition of node.transitions) {
        if (!ids.has(transition.to)) fail(`Unknown script target: ${transition.to}`);
        for (const match of transition.matches) {
          const key = `${transition.event}:${match.normalize('NFKC').trim().toLowerCase()}`;
          if (!match.trim() || events.has(key)) fail(`Ambiguous script transition in ${node.id}`);
          if (transition.event === 'dtmf' && !/^[0-9*#]$/.test(match))
            fail('DTMF matches must be one digit, * or #');
          events.add(key);
        }
      }
    }
    const reached = new Set<string>();
    const visit = (id: string) => {
      if (reached.has(id)) return;
      reached.add(id);
      graph.nodes.find((node) => node.id === id)?.transitions.forEach((edge) => visit(edge.to));
    };
    visit(graph.start);
    if (graph.nodes.some((node) => !reached.has(node.id)))
      fail('Script contains unreachable nodes');
  });

export type ScriptGraph = z.infer<typeof ScriptGraph>;
