DO $$
BEGIN
  IF to_regclass('public.ovo_jobs') IS NOT NULL THEN
    UPDATE ovo_jobs SET
      status = 'reconcile_required',
      owner_id = NULL, owner_epoch = owner_epoch + 1, lease_expires_at = NULL,
      not_before = 'infinity'::timestamptz,
      last_error = 'restore quarantine: reconcile external effects and explicitly reauthorize before delivery',
      updated_at = now()
    WHERE status IN ('queued','owned','dialing','reconcile_required','accepted','connected');
  END IF;
  IF to_regclass('public.ovo_session_routes') IS NOT NULL THEN
    UPDATE ovo_session_routes SET
      status = CASE WHEN status IN ('dialing','accepted','connected') THEN 'terminating' ELSE status END,
      owner_epoch = owner_epoch + 1, generation = generation + 1,
      handshake_expires_at = now() - interval '1 second', updated_at = now()
    WHERE status IN ('dialing','accepted','connected','terminating');
  END IF;
  IF to_regclass('public.ovo_capacity_leases') IS NOT NULL THEN
    UPDATE ovo_capacity_leases SET epoch=epoch+1,
      authority_id='restore-fence-'||epoch::text,
      lease_expires_at=now()-interval '1 second',updated_at=now();
  END IF;
  IF to_regclass('public.ovo_worker_slots') IS NOT NULL THEN
    UPDATE ovo_worker_slots SET state='draining',ownership_epoch=ownership_epoch+1,
      lease_expires_at=now()-interval '1 second',observed_at=now();
  END IF;
  IF to_regclass('public.ovo_outbox') IS NOT NULL THEN
    UPDATE ovo_outbox SET
      publishing_by='restore-fence',publishing_until='infinity'::timestamptz,
      last_error='restore quarantine: release only with explicit job reauthorization'
    WHERE sent_at IS NULL;
  END IF;
  IF to_regclass('public.ovo_eval_runs') IS NOT NULL THEN
    UPDATE ovo_eval_runs SET
      status='failed',owner_id=NULL,owner_epoch=owner_epoch+1,lease_expires_at=NULL,
      error='restore quarantine: provider execution or billing may have occurred after the restore point',
      updated_at=now(),completed_at=now()
    WHERE executor_kind='provider' AND status IN ('queued','running','cancelling');
    UPDATE ovo_eval_runs SET
      status=CASE WHEN status='cancelling' THEN 'cancelled'
                  WHEN attempt<max_attempts THEN 'queued' ELSE 'failed' END,
      owner_id=NULL,owner_epoch=owner_epoch+1,lease_expires_at=NULL,
      error='restore fence invalidated previous owner',updated_at=now(),
      completed_at=CASE WHEN status='cancelling' OR attempt>=max_attempts THEN now() ELSE NULL END
    WHERE executor_kind='fixture' AND status IN ('running','cancelling');
  END IF;
  IF to_regclass('public.ovo_eval_provider_authorizations') IS NOT NULL THEN
    UPDATE ovo_eval_provider_authorizations SET
      revoked_by='restore-fence',revoked_at=now()
    WHERE revoked_at IS NULL;
  END IF;
  IF to_regclass('public.ovo_recording_exports') IS NOT NULL THEN
    UPDATE ovo_recording_exports SET state='queued',lease_owner=NULL,
      lease_epoch=lease_epoch+1,lease_expires_at=NULL,
      error='restore fence invalidated previous owner',updated_at=now()
    WHERE state='running';
  END IF;
  IF to_regclass('public.ovo_ops_campaign_contacts') IS NOT NULL THEN
    UPDATE ovo_ops_campaign_contacts SET
      state='unknown',owner_id=NULL,owner_epoch=owner_epoch+1,
      admission_campaign_version=NULL,lease_expires_at=NULL,
      not_before='infinity'::timestamptz,updated_at=now()
    WHERE state IN ('queued','admitted','dialing','active');
  END IF;
  IF to_regclass('public.ovo_ops_attempts') IS NOT NULL THEN
    UPDATE ovo_ops_attempts SET
      status='unknown',terminal_reason=COALESCE(
        terminal_reason,
        'restore quarantine: reconcile carrier state before contact reauthorization'
      ),updated_at=now()
    WHERE status IN ('authorized','dialing','connected');
  END IF;
  IF to_regclass('public.ovo_ops_outbox') IS NOT NULL THEN
    UPDATE ovo_ops_outbox SET
      claimed_by='restore-fence',claim_expires_at='infinity'::timestamptz,
      available_at='infinity'::timestamptz,
      last_error='restore quarantine: never dispatch this restored admission automatically'
    WHERE sent_at IS NULL;
  END IF;
  IF to_regclass('public.ovo_ops_inbound_capacity') IS NOT NULL THEN
    UPDATE ovo_ops_inbound_capacity SET ready=false,generation=generation+1,
      protected_until=now()-interval '1 second',reservation_id=NULL,reserved_call_id=NULL,updated_at=now();
  END IF;
  IF to_regclass('public.ovo_ops_inbound_admissions') IS NOT NULL THEN
    UPDATE ovo_ops_inbound_admissions SET
      decision='busy',released_at=COALESCE(released_at,now()),
      detail=jsonb_build_object(
        'kind','busy','reason','restore_quarantine','previousDecision',decision,'restoredDetail',detail
      )
    WHERE released_at IS NULL AND (
      decision='wait' OR (
        decision='callback' AND COALESCE(detail->>'state','prompt') IN ('prompt','queued')
      )
    );
  END IF;
END $$;
