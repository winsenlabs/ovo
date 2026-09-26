import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import { Cap, type CapacitySignal, type CapacitySignalPublisher } from '@winsendotai/ovo-contracts';
import { AwsCapacityMetricPublisher } from './aws.ts';

export class LogCapacitySignalPublisher implements CapacitySignalPublisher {
  private previous?: CapacitySignal;

  constructor(
    private readonly log: (entry: Record<string, unknown>) => void = (entry) =>
      console.info(JSON.stringify(entry)),
  ) {}

  async publish(signal: CapacitySignal): Promise<void> {
    this.log({ event: 'capacity_signal', ...signal, at: signal.at.toISOString() });
    this.previous = signal;
  }

  last(): CapacitySignal | undefined {
    return this.previous;
  }
}

export const cloudwatchCapacitySignalPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/cloudwatch-capacity-signal',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: [Cap.capacitySignal],
    configSchema: {
      type: 'object',
      required: ['environment'],
      properties: {
        environment: { type: 'string' },
        region: { type: 'string' },
      },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    if (typeof config.environment !== 'string' || !config.environment)
      throw new Error('Capacity signal environment is required');
    ctx.provide(
      Cap.capacitySignal,
      new AwsCapacityMetricPublisher(config.environment, undefined, {
        region: typeof config.region === 'string' ? config.region : undefined,
      }),
    );
  },
);

export const logCapacitySignalPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/log-capacity-signal',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: [Cap.capacitySignal],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx: Context) => {
    ctx.provide(Cap.capacitySignal, new LogCapacitySignalPublisher());
  },
);

export const plugins = [cloudwatchCapacitySignalPlugin, logCapacitySignalPlugin];
