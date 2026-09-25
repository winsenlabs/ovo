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
  description = "Secrets Manager JSON secret containing DATABASE_URL, OVO_SECRETS_MASTER_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OVO_MEDIA_WORKER_TOKEN and, when inbound is enabled, OVO_INBOUND_ROUTE_SECRET."
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
  default     = 1
  description = "One active gateway while worker WebSocket ownership is process-local."
  validation {
    condition     = var.gateway_desired_count == 1
    error_message = "gateway_desired_count must remain 1 until gateway worker connections use a distributed ownership transport."
  }
}
variable "worker_initial_desired_count" {
  type        = number
  default     = 0
  description = "Bootstrap only. Terraform ignores later drift; the fenced dispatcher is the only runtime writer."
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
