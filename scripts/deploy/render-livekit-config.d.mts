export function parseEnvFile(text: string): Record<string, string>;
export function renderLivekitConfig(
  env: Readonly<Record<string, string | undefined>>,
  options?: { template?: string; loopbackInterface?: string },
): string;
