import { convertMinor, parseDecimal, parseMinor } from './money.ts';

export type ScenarioCategory = 'telephony' | 'tax' | 'speech-generation' | 'carrier-media' | 'idle';

export interface InrScenarioInput {
  targetRevenuePaise: string;
  durationSeconds: string;
  components: {
    id: string;
    category: ScenarioCategory;
    amountMinor: string;
    currency: string;
    assumption: string;
    fx?: {
      id: string;
      version: string;
      baseCurrency: string;
      quoteCurrency: 'INR';
      rateNumerator: string;
      rateDenominator: string;
    };
  }[];
  cache: {
    generatedUnits: string;
    hitUnits: string;
    generationBilledOnce: true;
    carrierMediaStillBilled: true;
    assumption: string;
  };
  marginScope: string;
}

export interface InrScenarioResult {
  targetRevenuePaise: string;
  durationSeconds: string;
  totalCostPaise: string;
  marginPaise: string;
  withinTarget: boolean;
  marginScope: string;
  cache: InrScenarioInput['cache'];
  components: (InrScenarioInput['components'][number] & { amountPaise: string })[];
}

export interface InrScenarioService {
  calculate(input: InrScenarioInput): InrScenarioResult;
}

const REQUIRED: ScenarioCategory[] = [
  'telephony',
  'tax',
  'speech-generation',
  'carrier-media',
  'idle',
];

/** Scenario calculator only: callers must supply every cost, FX, cache, tax and margin assumption. */
export function calculateInrScenario(input: InrScenarioInput): InrScenarioResult {
  const revenue = parseMinor(input.targetRevenuePaise);
  parseDecimal(input.cache.generatedUnits);
  parseDecimal(input.cache.hitUnits);
  if (
    parseMinor(input.durationSeconds) <= 0n ||
    !input.marginScope.trim() ||
    !input.cache.assumption.trim() ||
    input.cache.generationBilledOnce !== true ||
    input.cache.carrierMediaStillBilled !== true
  )
    throw new TypeError('Scenario duration, cache assumption and margin scope are required');
  for (const category of REQUIRED)
    if (!input.components.some((component) => component.category === category))
      throw new TypeError(`Missing explicit ${category} scenario component`);

  const components = input.components.map((component) => {
    if (!component.id || !component.assumption.trim())
      throw new TypeError('Scenario component provenance is required');
    if (!/^[A-Z]{3}$/.test(component.currency))
      throw new TypeError('Scenario component currency must be ISO 4217');
    if (component.currency === 'INR' && component.fx)
      throw new TypeError('INR scenario components must not fabricate FX');
    const amountPaise =
      component.currency === 'INR'
        ? parseMinor(component.amountMinor).toString()
        : convertScenarioCurrency(component);
    return { ...component, amountPaise };
  });
  if (new Set(components.map((component) => component.id)).size !== components.length)
    throw new TypeError('Scenario component IDs must be unique');
  const total = components.reduce((sum, component) => sum + BigInt(component.amountPaise), 0n);
  return {
    targetRevenuePaise: revenue.toString(),
    durationSeconds: input.durationSeconds,
    totalCostPaise: total.toString(),
    marginPaise: (revenue - total).toString(),
    withinTarget: total <= revenue,
    marginScope: input.marginScope,
    cache: structuredClone(input.cache),
    components,
  };
}

function convertScenarioCurrency(component: InrScenarioInput['components'][number]): string {
  const fx = component.fx;
  if (
    !fx ||
    fx.baseCurrency !== component.currency ||
    fx.quoteCurrency !== 'INR' ||
    !fx.id ||
    !fx.version
  )
    throw new TypeError('Non-INR scenario components require explicit matching versioned FX');
  return convertMinor(component.amountMinor, fx.rateNumerator, fx.rateDenominator);
}
