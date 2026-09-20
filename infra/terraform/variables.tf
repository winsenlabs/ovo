variable "aws_region" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "certificate_arn" { type = string }
variable "runtime_secret_arn" {
  type        = string
  description = "Secrets Manager JSON secret containing DATABASE_URL, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
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
  type    = number
  default = 2
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
variable "media_readiness_url" {
  type        = string
  default     = ""
  description = "Internal session-handler readiness URL required before dialing when enable_live_dial is true."
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
