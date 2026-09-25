export const releaseSelectionsV4 = `
ALTER TABLE ovo_ctl_releases ADD COLUMN IF NOT EXISTS selections JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ovo_ctl_releases'::regclass AND conname='ovo_ctl_releases_selections_object') THEN
    ALTER TABLE ovo_ctl_releases ADD CONSTRAINT ovo_ctl_releases_selections_object CHECK (jsonb_typeof(selections) = 'object');
  END IF;
END $$;

ALTER TABLE ovo_ctl_provider_bindings ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE ovo_ctl_provider_bindings ADD COLUMN IF NOT EXISTS plugin_id TEXT;

DO $$ DECLARE old_name TEXT;
BEGIN
  SELECT conname INTO old_name FROM pg_constraint
   WHERE conrelid='ovo_ctl_calls'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%kind%'
   LIMIT 1;
  IF old_name IS NOT NULL AND old_name <> 'ovo_ctl_calls_kind_allowed' THEN
    EXECUTE format('ALTER TABLE ovo_ctl_calls DROP CONSTRAINT %I', old_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ovo_ctl_calls'::regclass AND conname='ovo_ctl_calls_kind_allowed') THEN
    ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_allowed CHECK (kind IN ('live','simulation','test'));
  END IF;
END $$;

UPDATE ovo_ctl_provider_bindings SET kind='stt', plugin_id='@winsendotai/ovo-provider-deepgram-stt'
 WHERE kind IS NULL AND plugin_id IS NULL AND provider='deepgram';
UPDATE ovo_ctl_provider_bindings SET kind='carrier', plugin_id='@winsendotai/ovo-carrier-twilio'
 WHERE kind IS NULL AND plugin_id IS NULL AND provider='twilio';
UPDATE ovo_ctl_provider_bindings b SET kind='tts', plugin_id='@winsendotai/ovo-provider-openai-tts'
 WHERE b.kind IS NULL AND b.plugin_id IS NULL AND b.provider='openai'
   AND EXISTS (
     SELECT 1 FROM ovo_ctl_agents a
      WHERE a.workspace_id=b.workspace_id AND a.config->'providers'->>'tts'=b.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM ovo_ctl_agents a, jsonb_each_text(COALESCE(a.config->'providers','{}'::jsonb)) p
      WHERE a.workspace_id=b.workspace_id AND p.value=b.id AND p.key<>'tts'
   );
UPDATE ovo_ctl_provider_bindings b SET kind='llm', plugin_id='@winsendotai/ovo-provider-openai-inference'
 WHERE b.kind IS NULL AND b.plugin_id IS NULL AND b.provider='openai'
   AND EXISTS (
     SELECT 1 FROM ovo_ctl_agents a
      WHERE a.workspace_id=b.workspace_id AND a.config->'providers'->>'inference'=b.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM ovo_ctl_agents a, jsonb_each_text(COALESCE(a.config->'providers','{}'::jsonb)) p
      WHERE a.workspace_id=b.workspace_id AND p.value=b.id AND p.key<>'inference'
   );
`;
