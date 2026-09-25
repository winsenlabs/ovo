export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

const DECIMAL = /^(-?)(0|[1-9]\d{0,59})(?:\.(\d{1,18}))?$/;
const INTEGER = /^-?(0|[1-9]\d{0,59})$/;

export function parseDecimal(value: string, signed = false): Rational {
  const match = DECIMAL.exec(value);
  if (!match || (!signed && match[1])) throw new TypeError('Invalid decimal value');
  const fraction = match[3] ?? '';
  const sign = match[1] ? -1n : 1n;
  return reduce({
    numerator: sign * BigInt(`${match[2]}${fraction}`),
    denominator: 10n ** BigInt(fraction.length),
  });
}

export function parseMinor(value: string, signed = false): bigint {
  if (!INTEGER.test(value) || (!signed && value.startsWith('-')))
    throw new TypeError('Invalid minor-unit integer');
  return BigInt(value);
}

export function multiply(left: Rational, right: Rational): Rational {
  return reduce({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  });
}

export function divide(left: Rational, right: Rational): Rational {
  if (right.numerator === 0n) throw new RangeError('Cannot divide by zero');
  const sign = right.numerator < 0n ? -1n : 1n;
  return reduce({
    numerator: left.numerator * right.denominator * sign,
    denominator: left.denominator * abs(right.numerator),
  });
}

/** Half-up rounding, away from zero for an exact negative half. */
export function roundMinor(value: Rational): bigint {
  const negative = value.numerator < 0n;
  const numerator = abs(value.numerator);
  const rounded = (numerator * 2n + value.denominator) / (2n * value.denominator);
  return negative ? -rounded : rounded;
}

export function convertMinor(
  amountMinor: string,
  rateNumerator: string,
  rateDenominator: string,
): string {
  const denominator = parseMinor(rateDenominator);
  if (denominator <= 0n) throw new RangeError('FX denominator must be positive');
  const numerator = parseMinor(rateNumerator);
  if (numerator < 0n) throw new RangeError('FX numerator must be nonnegative');
  return roundMinor({
    numerator: parseMinor(amountMinor, true) * numerator,
    denominator,
  }).toString();
}

export interface WeightedTarget {
  id: string;
  weight: string;
}

/** Largest-remainder allocation; ties use stable target IDs and totals always reconcile exactly. */
export function allocateMinor(
  totalMinor: string,
  targets: readonly WeightedTarget[],
): Map<string, string> {
  const total = parseMinor(totalMinor);
  if (total < 0n || targets.length === 0)
    throw new TypeError('Allocation requires a nonnegative total and targets');
  const parsed = targets.map((target) => ({ ...target, ratio: parseDecimal(target.weight) }));
  if (new Set(parsed.map((target) => target.id)).size !== parsed.length)
    throw new TypeError('Allocation target IDs must be unique');
  const common = parsed.reduce((product, target) => product * target.ratio.denominator, 1n);
  const weights = parsed.map((target) => ({
    id: target.id,
    value: target.ratio.numerator * (common / target.ratio.denominator),
  }));
  const sum = weights.reduce((value, target) => value + target.value, 0n);
  if (sum <= 0n) throw new TypeError('Allocation weights must have a positive sum');
  const rows = weights.map((target) => ({
    id: target.id,
    amount: (total * target.value) / sum,
    remainder: (total * target.value) % sum,
  }));
  let remaining = total - rows.reduce((value, row) => value + row.amount, 0n);
  rows.sort((a, b) =>
    a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1,
  );
  for (const row of rows) {
    if (remaining === 0n) break;
    row.amount += 1n;
    remaining -= 1n;
  }
  return new Map(rows.map((row) => [row.id, row.amount.toString()]));
}

function reduce(value: Rational): Rational {
  if (value.denominator <= 0n) throw new RangeError('Rational denominator must be positive');
  const divisor = gcd(abs(value.numerator), value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left || 1n;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
