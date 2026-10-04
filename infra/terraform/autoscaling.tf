locals {
  capacity_dimensions = {
    Environment = var.environment
    Service     = "workers"
  }
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = var.worker_max_capacity
  min_capacity       = var.enable_inbound_calls ? var.inbound_warm_floor : 0
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Target tracking owns the only scale-in path. Maximum combines identical dispatcher replicas.
resource "aws_appautoscaling_policy" "worker_target" {
  name               = "${local.name}-worker-required-ratio"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 1.0
    scale_out_cooldown = 60
    scale_in_cooldown  = var.worker_scale_in_cooldown_seconds
    customized_metric_specification {
      metrics {
        id          = "req"
        return_data = false
        metric_stat {
          stat = "Maximum"
          metric {
            metric_name = "RequiredSlots"
            namespace   = "OVO/Capacity"
            dimensions {
              name  = "Environment"
              value = var.environment
            }
            dimensions {
              name  = "Service"
              value = "workers"
            }
          }
        }
      }
      metrics {
        id          = "prov"
        return_data = false
        metric_stat {
          stat = "Maximum"
          metric {
            metric_name = "ProvisionedTasks"
            namespace   = "OVO/Capacity"
            dimensions {
              name  = "Environment"
              value = var.environment
            }
            dimensions {
              name  = "Service"
              value = "workers"
            }
          }
        }
      }
      metrics {
        id          = "ratio"
        expression  = "IF(prov>0,req/prov,req)"
        return_data = true
      }
    }
  }
}

# A high-resolution deficit alarm scales out quickly, including from zero; it has no scale-in steps.
resource "aws_appautoscaling_policy" "worker_step_out" {
  name               = "${local.name}-worker-deficit"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 30
    metric_aggregation_type = "Maximum"
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 2
      scaling_adjustment          = 2
    }
    step_adjustment {
      metric_interval_lower_bound = 2
      metric_interval_upper_bound = 5
      scaling_adjustment          = 5
    }
    step_adjustment {
      metric_interval_lower_bound = 5
      metric_interval_upper_bound = 10
      scaling_adjustment          = 10
    }
    step_adjustment {
      metric_interval_lower_bound = 10
      scaling_adjustment          = 20
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_deficit" {
  alarm_name          = "${local.name}-worker-deficit"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_step_out.arn, var.alarm_topic_arn]

  metric_query {
    id          = "req"
    return_data = false
    metric {
      metric_name = "RequiredSlots"
      namespace   = "OVO/Capacity"
      period      = 10
      stat        = "Maximum"
      dimensions  = local.capacity_dimensions
    }
  }
  metric_query {
    id          = "prov"
    return_data = false
    metric {
      metric_name = "ProvisionedTasks"
      namespace   = "OVO/Capacity"
      period      = 10
      stat        = "Maximum"
      dimensions  = local.capacity_dimensions
    }
  }
  metric_query {
    id          = "deficit"
    expression  = "req-prov"
    return_data = true
  }
}

resource "aws_appautoscaling_scheduled_action" "worker" {
  for_each           = { for item in var.worker_schedules : item.name => item }
  name               = each.value.name
  schedule           = each.value.schedule
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_target_action {
    min_capacity = each.value.min_capacity
    max_capacity = each.value.max_capacity
  }
}
