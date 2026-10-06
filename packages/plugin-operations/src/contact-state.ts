export type ContactState =
  | 'queued'
  | 'admitted'
  | 'dialing'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'superseded'
  | 'suppressed'
  | 'exhausted'
  /** Its variables failed the release's declared schema at admission; it is never dialed. */
  | 'invalid';
