# Recording or export failure

**Trigger:** artifact remains starting/finalizing, upload/checksum fails, export job errors, or retention deletion is incomplete.  
**Owner:** data operations with security/privacy owner.  
**Signals:** artifact state, object checksum/metadata, asynchronous job attempts, retention deadline, access audit.

## Procedure

1. Keep state accurate: disabled, finalizing, failed, expired and available are distinct. Never synthesize an available URL.
2. Preserve transcript/events independently. Retry upload/export only with the same artifact/operation identity and a bounded safe retry.
3. Validate workspace authorization, encryption, checksum, channel/codec and timestamp alignment before exposing an expiring link.
4. For retention deletion, remove eligible original/derived indexes/exports and retain the required audit/tombstone. Check backup behavior separately.

## Recovery and verification

If retry is unsafe or source media is partial, mark failed/partial and notify the authorized operator. Verify replay defaults to stub tools and cannot dial or mutate production. Retain artifact IDs, checksums, attempts, access decisions and deletion coverage.
