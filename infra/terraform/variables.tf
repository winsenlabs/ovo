variable "aws_region" { type = string }
variable "environment" { type = string }
variable "organization_id" {
  type        = string
  description = "Fixed organization identifier for this self-hosted single-tenant installation."
}

variable "plugin_modules_json" {
  description = "JSON array of trusted installed session extension package identifiers"
  type        = string
  default     = "[]"
}
variable "recordings_bucket" {
  description = "Existing private S3 bucket for encrypted production call recordings"
  type        = string
}
variable "recording_retention_days" {
  description = "Retention period applied to new live recording artifacts"
  type        = number
  default     = 30
  validation {
    condition     = var.recording_retention_days >= 1 && var.recording_retention_days <= 365
    error_message = "recording_retention_days must be between 1 and 365."
  }
}
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "certificate_arn" { type = string }
variable "runtime_secret_arn" {
  type        = string
  description = "Secrets Manager JSON secret containing DATABASE_URL, OVO_SECRETS_MASTER_KEY, OVO_SESSION_SECRET, OVO_SEED_ADMIN_EMAIL, OVO_SEED_ADMIN_PASSWORD, OVO_CARRIER_ENV_BINDINGS, OVO_MEDIA_WORKER_TOKEN and OVO_INBOUND_ROUTE_SECRET."
}
variable "alb_subnet_cidrs" {
  type        = list(string)
  description = "CIDRs of the ALB subnets trusted by the API proxy boundary."
}
variable "enable_inbound_calls" {
  type        = bool
  default     = false
  description = "Enable signed Twilio inbound admission after protected worker capacity is configured."
}
variable "database_security_group_id" { type = string }
variable "api_image" { type = string }
variable "console_image" { type = string }
variable "dispatcher_image" { type = string }
variable "gateway_image" { type = string }
variable "worker_image" { type = string }
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "console_desired_count" {
  type    = number
  default = 2
}
variable "gateway_desired_count" {
  type        = number
  default     = 2
  description = "Stateless gateway replicas behind the ALB."
  validation {
    condition     = var.gateway_desired_count >= 2
    error_message = "gateway_desired_count must be at least 2."
  }
}
variable "worker_initial_desired_count" {
  type        = number
  default     = 0
  description = "Bootstrap only. Terraform ignores later drift; Application Auto Scaling is the only runtime writer."
}
variable "enable_live_dial" {
  type        = bool
  default     = false
  description = "Fail-closed gate. Set true only after the media session handler and carrier gates are certified."
}
variable "transport_certified" {
  type        = bool
  default     = false
  description = "Separate operator assertion checked by worker readiness; Terraform does not certify transport."
}
variable "enable_routing" {
  type        = bool
  default     = false
  description = "OVO_ROUTING_ENABLED (api, gateway): routing points and agent pools. Off, a routed number is answered by its release's default agent."
}
variable "enable_routing_external" {
  type        = bool
  default     = false
  description = "OVO_ROUTING_EXTERNAL_ENABLED (api, worker): lets the routing external engine post its signed decision webhook."
}
variable "routing_prepare_timeout_ms" {
  type        = string
  default     = ""
  description = "OVO_ROUTING_PREPARE_TIMEOUT_MS (worker): bound on composing a routed agent, 500-10000 ms. Empty keeps 2500."
  validation {
    condition     = var.routing_prepare_timeout_ms == "" || can(regex("^[0-9]+$", var.routing_prepare_timeout_ms))
    error_message = "routing_prepare_timeout_ms is empty or a whole number of milliseconds."
  }
}
variable "enable_routing_transfer" {
  type        = bool
  default     = false
  description = "OVO_ROUTING_TRANSFER_ENABLED (worker, api): in-call agent transfer on routed calls. Off, routed calls run as Wave 15."
}
variable "enable_routing_simulate_live" {
  type        = bool
  default     = false
  description = "OVO_ROUTING_SIMULATE_LIVE_ENABLED (api): admins may run the decision and LLM engines for real in the route tester. They cost provider money. Off, the tester uses scripted answers only."
}
variable "routing_simulate_rate_per_minute" {
  type        = number
  default     = 30
  description = "OVO_ROUTING_SIMULATE_RATE_PER_MINUTE (api): route simulations and eval runs one identity may start a minute, 1-600."
  validation {
    condition     = var.routing_simulate_rate_per_minute >= 1 && var.routing_simulate_rate_per_minute <= 600 && floor(var.routing_simulate_rate_per_minute) == var.routing_simulate_rate_per_minute
    error_message = "routing_simulate_rate_per_minute is a whole number from 1 to 600."
  }
}
variable "enable_human_queue" {
  type        = bool
  default     = false
  description = "OVO_HUMAN_QUEUE_ENABLED (api, worker, dispatcher): human queues (third-party webhook and operator desk). Needs enable_routing and enable_routing_transfer. Off, human steps are skipped."
}
variable "human_queue_webhook_enabled" {
  type        = bool
  default     = false
  description = "OVO_HUMAN_QUEUE_WEBHOOK_ENABLED (api, worker): lets external queues post their signed hand-off webhook. Off, external queues are inert."
}
variable "human_queue_callback_base_url" {
  type        = string
  default     = ""
  description = "OVO_HUMAN_QUEUE_CALLBACK_BASE_URL (worker): public origin put in webhook callback links. Empty falls back to media_public_base_url."
  validation {
    condition     = var.human_queue_callback_base_url == "" || can(regex("^https://[^/]+$", var.human_queue_callback_base_url))
    error_message = "human_queue_callback_base_url is empty or an https origin without a path."
  }
}
variable "human_queue_context_retention_hours" {
  type        = string
  default     = ""
  description = "OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS (api, worker, dispatcher): hours a ticket's caller context is kept after it ends, 0-720. Empty keeps 24."
  validation {
    condition     = var.human_queue_context_retention_hours == "" || can(regex("^[0-9]+$", var.human_queue_context_retention_hours))
    error_message = "human_queue_context_retention_hours is empty or a whole number of hours."
  }
}
variable "enable_livekit" {
  type        = bool
  default     = false
  description = "Reserved. The self-hosted room server (managed human queues) needs a static-IP, non-Spot host with UDP; Fargate cannot run it, so true is refused."
  validation {
    condition     = !var.enable_livekit
    error_message = "enable_livekit is not supported on the Fargate profile: the room server runs on the Compose host (docs/runbooks/livekit-deploy.md)."
  }
}
variable "permitted_from_numbers" {
  type        = list(string)
  default     = []
  description = "E.164 caller IDs permitted for direct live launch. Empty keeps launch blocked."
}
variable "enable_twilio_handoff" {
  type        = bool
  default     = false
  description = "Enable authoritative Twilio call-update handoff support in API and workers."
}
variable "twilio_handoff_resume_url" {
  type        = string
  default     = ""
  description = "Optional public HTTPS TwiML URL used for handoff fallback resume."
}
variable "media_readiness_url" {
  type        = string
  default     = ""
  description = "Internal session-handler readiness URL required before dialing when enable_live_dial is true."
}
variable "media_public_base_url" {
  type        = string
  description = "Exact externally visible HTTPS origin used to validate signed carrier media requests."
}
variable "inbound_warm_floor" {
  type    = number
  default = 0
}
variable "worker_max_capacity" {
  type    = number
  default = 100
}
variable "carrier_concurrency" {
  type        = number
  default     = 100
  description = "Configured carrier starts ceiling; reconcile with the live carrier quota before raising."
}
variable "provider_concurrency" {
  type        = number
  default     = 100
  description = "Configured provider starts ceiling; reconcile with the live provider quota before raising."
}
variable "spend_permitted_starts" {
  type        = number
  default     = 100
  description = "Configured spend-permitted starts ceiling; reconcile with the live spend gate before raising."
}
variable "max_call_seconds" {
  type    = number
  default = 3600
}
variable "worker_scale_in_cooldown_seconds" {
  type    = number
  default = 300
}
variable "worker_schedules" {
  description = "Scheduled capacity overrides (paired raise and restore entries)."
  type = list(object({
    name         = string
    schedule     = string
    min_capacity = number
    max_capacity = number
  }))
  default = []
}
variable "alarm_topic_arn" {
  description = "SNS topic receiving every OVO infrastructure alarm."
  type        = string
}
variable "job_age_slo_seconds" {
  type    = number
  default = 120
}
variable "worker_cpu" {
  type    = number
  default = 1024
}
variable "worker_memory" {
  type    = number
  default = 2048
}
variable "alb_idle_timeout_seconds" {
  type    = number
  default = 300
}
