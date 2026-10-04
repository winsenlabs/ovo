export const callKindConstraintV5 = `
DO $$ DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid='ovo_ctl_calls'::regclass AND contype='c'
  LOOP
    IF item.definition = 'CHECK ((kind = ANY (ARRAY[''live''::text, ''simulation''::text])))' THEN
      EXECUTE format('ALTER TABLE ovo_ctl_calls DROP CONSTRAINT %I', item.conname);
    ELSIF item.definition LIKE '%kind = ANY (ARRAY[''live''::text, ''simulation''::text])%' THEN
      RAISE EXCEPTION 'compound call-kind constraint % needs manual review', item.conname;
    ELSIF item.conname = 'ovo_ctl_calls_kind_allowed'
      AND item.definition <> 'CHECK ((kind = ANY (ARRAY[''live''::text, ''simulation''::text, ''test''::text])))' THEN
      RAISE EXCEPTION 'unexpected call-kind constraint % needs manual review', item.conname;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='ovo_ctl_calls'::regclass
       AND conname='ovo_ctl_calls_kind_allowed'
  ) THEN
    ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_allowed
      CHECK (kind IN ('live','simulation','test'));
  END IF;
END $$;
`;
