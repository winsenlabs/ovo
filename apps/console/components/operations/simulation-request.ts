export type SimulationMode = 'fixture' | 'provider';

export function simulationRequest(
  releaseId: FormDataEntryValue | null,
  input: FormDataEntryValue | null,
  mode: SimulationMode,
  bindings: Record<string, unknown>,
  followUpInputs: string[] = [],
) {
  const request: {
    releaseId: FormDataEntryValue | null;
    input: FormDataEntryValue | null;
    variables: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    followUpInputs?: string[];
  } = { releaseId, input, variables: {} };
  if (mode === 'fixture') request.bindings = bindings;
  if (followUpInputs.length) request.followUpInputs = followUpInputs;
  return request;
}

export function parseFollowUpInputs(text: string): string[] {
  const inputs = text
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (inputs.length > 19) throw new Error('Enter at most 19 follow-up inputs.');
  return inputs;
}
