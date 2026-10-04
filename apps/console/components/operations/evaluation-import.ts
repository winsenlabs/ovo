export function parseEvaluationCorpus(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  const cases = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : undefined;
  if (!cases) throw new Error('Expected a JSON array or an object with a cases array.');
  if (cases.length < 1 || cases.length > 120)
    throw new Error('Import must contain between 1 and 120 cases.');
  return cases;
}
