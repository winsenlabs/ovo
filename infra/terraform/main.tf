data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name               = "ovo-${var.environment}"
  worker_service     = "${local.name}-worker"
  worker_service_arn = "arn:aws:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/${local.worker_service}"
  common_environment = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "OVO_ENVIRONMENT", value = var.environment },
    { name = "OVO_ORGANIZATION_ID", value = var.organization_id },
    { name = "OVO_PLUGIN_MODULES", value = var.plugin_modules_json },
    { name = "OVO_RECORDINGS_BACKEND", value = "s3" },
    { name = "OVO_RECORDINGS_BUCKET", value = var.recordings_bucket },
    { name = "OVO_RECORDING_RETENTION_DAYS", value = tostring(var.recording_retention_days) },
  ]
  runtime_secrets = [
    { name = "DATABASE_URL", valueFrom = "${var.runtime_secret_arn}:DATABASE_URL::" },
  ]
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/ovo/${var.environment}/application"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${local.name}-jobs-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 8
  })
}
