import type {
  AgentConfig,
  Execution,
  SpeechReceipt,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { FaqBehavior } from './faq.ts';
import { renderAnnouncementTemplate, validateTemplatePaths } from './announcement.ts';
import { ToolConfirmation } from './confirmation.ts';

export interface FaqExecutionOptions {
  workspaceId: string;
  sessionId: string;
  operationId?: () => string;
}

/** Deterministic selection and rendering; Execution alone may perform effects. */
export class ExecutingFaqBehavior extends FaqBehavior {
  private active?: AbortController;
  private readonly confirmation = new ToolConfirmation();
  private readonly operationId: () => string;
  private pendingEntry?: { operationId: string; entry: AgentConfig['faq'][number] };
  private uncertainWrite = false;

  constructor(
    config: AgentConfig,
    private readonly execution: Execution,
    private readonly identity: FaqExecutionOptions,
  ) {
    super(config);
    if (!identity.workspaceId || !identity.sessionId)
      throw new Error('FAQ execution needs session identity');
    this.operationId = identity.operationId ?? (() => crypto.randomUUID());
    for (const entry of this.config.faq) {
      if (!entry.requiresTool) continue;
      const tool = this.config.tools.find((tool) => tool.id === entry.requiresTool);
      if (!tool || !this.config.allowedTools.includes(tool.id))
        throw new Error('FAQ tool must be explicitly approved');
      validateTemplatePaths(entry.answer, {
        type: 'object',
        properties: { result: tool.outputSchema ?? {} },
      });
    }
  }

  override async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    try {
      if (this.confirmation.waiting) {
        const decision = this.confirmation.accept(input);
        if (decision.kind === 'declined') {
          this.pendingEntry = undefined;
          return 'Cancelled. No change was made.';
        }
        if (decision.kind === 'repeat') return decision.prompt;
        const pending = this.pendingEntry;
        this.pendingEntry = undefined;
        if (!pending || pending.operationId !== decision.selection.operationId)
          throw new Error('FAQ confirmation state is inconsistent');
        return await this.executeSelection(
          decision.selection.tool,
          decision.selection.input,
          pending.entry,
          decision.selection.operationId,
          true,
          controller,
        );
      }

      const match = this.match(input);
      if (match.kind === 'answer') return match.answer;
      if (match.reason !== 'requires-tool') return this.config.clarification;
      const entry = this.config.faq.find((candidate) => candidate.id === match.entryId)!;
      const tool = this.config.tools.find((candidate) => candidate.id === entry.requiresTool)!;
      const toolInput = bindInput(entry.toolInput ?? {}, variables);
      if (tool.effect === 'write' && this.uncertainWrite)
        return 'A previous change has an unconfirmed outcome. An operator must reconcile it before another change.';
      const operationId = this.operationId();
      if (tool.effect === 'write' || tool.confirmation) {
        this.pendingEntry = { operationId, entry };
        return this.confirmation.request({ tool, input: toolInput, operationId });
      }
      return await this.executeSelection(tool, toolInput, entry, operationId, false, controller);
    } catch (error) {
      controller.signal.throwIfAborted();
      return this.config.processing.failure;
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  beginTurn(epoch: number): void {
    this.confirmation.beginTurn(epoch);
  }

  onPlayback(receipt: SpeechReceipt): void {
    this.confirmation.played(receipt);
  }

  cancel(): void {
    this.active?.abort(new DOMException('FAQ turn cancelled', 'AbortError'));
    this.active = undefined;
  }

  private async executeSelection(
    tool: ToolDefinition,
    input: unknown,
    entry: AgentConfig['faq'][number],
    operationId: string,
    confirmed: boolean,
    controller: AbortController,
  ): Promise<string> {
    if (tool.effect === 'write') this.uncertainWrite = true;
    let result;
    try {
      result = await this.execution.execute(
        {
          id: operationId,
          workspaceId: this.identity.workspaceId,
          sessionId: this.identity.sessionId,
          toolId: tool.id,
          input,
          confirmed,
        },
        { signal: controller.signal },
      );
    } catch {
      controller.signal.throwIfAborted();
      return tool.processing?.failure ?? this.config.processing.failure;
    }
    if (tool.effect === 'write' && ['succeeded', 'failed'].includes(result.state))
      this.uncertainWrite = false;
    controller.signal.throwIfAborted();
    if (result.state !== 'succeeded')
      return tool.processing?.failure ?? this.config.processing.failure;
    return renderAnnouncementTemplate(
      entry.answer,
      { result: result.result },
      { type: 'object', properties: { result: tool.outputSchema ?? {} } },
      this.config,
    );
  }
}

function bindInput(value: unknown, variables: Record<string, unknown>, depth = 0): unknown {
  if (depth > 10) throw new Error('FAQ tool input nesting exceeds limit');
  if (typeof value === 'string') {
    const match = /^{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}$/.exec(value);
    if (!match) return value;
    if (
      ['__proto__', 'prototype', 'constructor'].includes(match[1]) ||
      !Object.hasOwn(variables, match[1])
    )
      throw new Error('FAQ tool input variable is unavailable');
    return structuredClone(variables[match[1]]);
  }
  if (Array.isArray(value)) return value.map((item) => bindInput(item, variables, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bindInput(item, variables, depth + 1)]),
    );
  return value;
}
