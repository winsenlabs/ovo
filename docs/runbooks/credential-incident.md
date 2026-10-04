# Credential incident

**Trigger:** suspected disclosure, unauthorized use, provider revocation or failed rotation.  
**Owner:** security incident commander; platform and affected provider owners assist.  
**Signals:** Secrets Manager metadata/audit, provider audit, failed readiness, affected binding/release lookup.

## Procedure

1. Stop new admission for bindings using the credential. Decide explicitly whether existing streams can continue safely.
2. Revoke/rotate in the provider console and Secrets Manager through approved access; never paste secret material into chat, logs, tickets or Terraform variables.
3. Create a new credential version/reference, validate server-side, bind approved releases, and retain the old reference as retiring until bounded in-flight use is understood.
4. Enumerate impacted agents, releases, calls and provider request IDs from metadata/audit only. Search logs for identifiers, not plaintext.
5. Re-run plugin readiness and a no-side-effect provider validation. Resume gradually.

## Rollback and verification

If the new credential fails, keep admission closed; do not reactivate a known-compromised credential. Retain rotation/revocation timestamps, affected references, access audit, readiness result and disclosure assessment. Verify ordinary APIs cannot read plaintext credentials.
