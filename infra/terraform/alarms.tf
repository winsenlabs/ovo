resource "aws_cloudwatch_metric_alarm" "jobs_dlq" {
  alarm_name          = "${local.name}-jobs-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  dimensions          = { QueueName = aws_sqs_queue.jobs_dlq.name }
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "oldest_eligible_job" {
  alarm_name          = "${local.name}-oldest-eligible-job"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.job_age_slo_seconds
  namespace           = "OVO/Capacity"
  metric_name         = "OldestEligibleJobAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  dimensions          = local.capacity_dimensions
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "stale_capacity_signal" {
  alarm_name          = "${local.name}-stale-capacity-signal"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 1
  namespace           = "OVO/Capacity"
  metric_name         = "RequiredSlots"
  statistic           = "SampleCount"
  period              = 60
  dimensions          = local.capacity_dimensions
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_ceiling" {
  alarm_name          = "${local.name}-worker-ceiling"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  threshold           = var.worker_max_capacity
  namespace           = "OVO/Capacity"
  metric_name         = "RequiredSlots"
  statistic           = "Maximum"
  period              = 60
  dimensions          = local.capacity_dimensions
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "target_health" {
  for_each = {
    api     = aws_lb_target_group.api.arn_suffix
    console = aws_lb_target_group.console.arn_suffix
    gateway = aws_lb_target_group.gateway.arn_suffix
  }
  alarm_name          = "${local.name}-${each.key}-target-health"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 1
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  dimensions = {
    TargetGroup  = each.value
    LoadBalancer = aws_lb.this.arn_suffix
  }
  treat_missing_data = "breaching"
  alarm_actions      = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_log_metric_filter" "protection_renewal_failed" {
  name           = "${local.name}-protection-renewal-failed"
  log_group_name = aws_cloudwatch_log_group.application.name
  pattern        = "{ $.event = \"protection_renewal_failed\" }"
  metric_transformation {
    name      = "ProtectionRenewalFailed"
    namespace = "OVO/Operations"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "protection_renewal_failed" {
  alarm_name          = "${local.name}-protection-renewal-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  namespace           = "OVO/Operations"
  metric_name         = aws_cloudwatch_log_metric_filter.protection_renewal_failed.metric_transformation[0].name
  statistic           = "Sum"
  period              = 60
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_log_metric_filter" "hint_exhausted" {
  name           = "${local.name}-hint-exhausted"
  log_group_name = aws_cloudwatch_log_group.application.name
  pattern        = "{ $.event = \"hint_exhausted\" }"
  metric_transformation {
    name      = "HintExhausted"
    namespace = "OVO/Operations"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "hint_exhausted" {
  alarm_name          = "${local.name}-hint-exhausted"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  namespace           = "OVO/Operations"
  metric_name         = aws_cloudwatch_log_metric_filter.hint_exhausted.metric_transformation[0].name
  statistic           = "Sum"
  period              = 60
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "job_queue_age" {
  alarm_name          = "${local.name}-job-queue-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.job_age_slo_seconds
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}
