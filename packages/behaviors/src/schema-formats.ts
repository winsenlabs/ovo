import type Ajv from 'ajv';

export function addIsoFormats(ajv: Ajv): void {
  ajv.addFormat('date', { type: 'string', validate: isIsoDate });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(new Date(value).valueOf()),
  });
  ajv.addFormat('time', {
    type: 'string',
    validate: (value) => {
      const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
      return (
        !!match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60
      );
    },
  });
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}
