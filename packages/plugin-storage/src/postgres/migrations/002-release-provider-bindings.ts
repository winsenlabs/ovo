export const releaseProviderBindingsV2 = `
ALTER TABLE ovo_ctl_releases
  ADD COLUMN provider_bindings JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(provider_bindings) = 'object');
`;
