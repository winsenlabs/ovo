/** Structural problems `routingDraftIssues` finds in a draft alone. */
export const ROUTING_STRUCTURAL_ISSUE_CODES = [
  'routing_root_missing',
  'routing_node_duplicate',
  'routing_node_unknown',
  'routing_node_cycle',
  'routing_node_unreachable',
  'routing_depth_exceeded',
  'routing_branch_duplicate',
  'routing_rule_branch_unknown',
  'routing_fallback_not_terminal',
  'routing_line_default_missing',
  'routing_language_unallowed',
  'routing_node_ask_missing',
  'routing_human_unavailable',
  'routing_limits_exceeded',
  // R2 transfer catalogue (`draft.transfer`).
  'routing_transfer_key_duplicate',
  'routing_transfer_node_unknown',
  'routing_transfer_timeout_not_terminal',
  'routing_transfer_timeout_target_unknown',
  'routing_transfer_hold_loop_invalid',
  'routing_transfer_return_unused',
  'routing_transfer_human_unavailable',
] as const;

/** Problems publish finds by resolving agents, releases, pools and credentials (API). */
export const ROUTING_RESOLUTION_ISSUE_CODES = [
  'routing_router_missing',
  'routing_router_mode',
  'routing_router_input_missing',
  'routing_router_cost_policy_missing',
  'routing_default_target_missing',
  'routing_pool_missing',
  'routing_pool_deleted',
  'routing_member_release_missing',
  'routing_member_meter_uncovered',
  'routing_engine_llm_unselected',
  'routing_engine_decision_unselected',
  'routing_external_endpoint_invalid',
  'routing_external_credential_missing',
  'routing_line_builtin_missing',
  'routing_external_disabled',
  'routing_recording_mismatch',
  'routing_language_uncovered',
  'routing_router_has_agent_config',
  /** The router and every target are one release: nothing to route between (R1 audit 5). */
  'routing_router_is_only_release',
  // R2 transfer catalogue.
  'routing_transfer_agent_missing',
  'routing_transfer_pool_missing',
  'routing_transfer_pool_deleted',
  'routing_transfer_audio_missing',
  'routing_transfer_audio_deleted',
  'routing_transfer_line_builtin_missing',
  'routing_transfer_disabled',
  'routing_transfer_unreachable',
  'routing_transfer_source_unknown',
] as const;

export const ROUTING_ISSUE_CODES = [
  ...ROUTING_STRUCTURAL_ISSUE_CODES,
  ...ROUTING_RESOLUTION_ISSUE_CODES,
] as const;
export type RoutingIssueCode = (typeof ROUTING_ISSUE_CODES)[number];
