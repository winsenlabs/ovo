resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  container_definitions = jsonencode([{
    name             = "api", image = var.api_image, essential = true
    portMappings     = [{ containerPort = 4000, protocol = "tcp" }]
    environment      = local.common_environment
    secrets          = local.runtime_secrets
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "api" } }
  }])
}

resource "aws_ecs_task_definition" "console" {
  family                   = "${local.name}-console"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.console.arn
  container_definitions = jsonencode([{
    name             = "console", image = var.console_image, essential = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = local.common_environment
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "console" } }
  }])
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${local.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway.arn
  container_definitions = jsonencode([{
    name         = "gateway", image = var.gateway_image, essential = true
    portMappings = [{ containerPort = 4001, protocol = "tcp" }]
    environment  = concat(local.common_environment, [{ name = "WORKER_DISCOVERY_HOST", value = "worker.${local.name}.internal" }])
    secrets = concat(local.runtime_secrets, [
      { name = "TWILIO_AUTH_TOKEN", valueFrom = "${var.runtime_secret_arn}:TWILIO_AUTH_TOKEN::" },
    ])
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "gateway" } }
  }])
}

resource "aws_ecs_task_definition" "dispatcher" {
  family                   = "${local.name}-dispatcher"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.dispatcher.arn
  container_definitions = jsonencode([{
    name         = "dispatcher", image = var.dispatcher_image, essential = true
    portMappings = [{ containerPort = 4002, protocol = "tcp" }]
    environment = concat(local.common_environment, [
      { name = "OVO_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "OVO_ECS_CLUSTER", value = aws_ecs_cluster.this.name },
      { name = "OVO_WORKER_SERVICE", value = local.worker_service },
      { name = "OVO_INBOUND_WARM_FLOOR", value = tostring(var.inbound_warm_floor) },
      { name = "OVO_WORKER_MAX_CAPACITY", value = tostring(var.worker_max_capacity) },
      { name = "OVO_CAPACITY_AUTHORITY", value = "dispatcher-postgres-fenced" },
    ])
    secrets          = local.runtime_secrets
    healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 15, timeout = 5, retries = 3, startPeriod = 30 }
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "dispatcher" } }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  container_definitions = jsonencode([{
    name         = "worker", image = var.worker_image, essential = true
    portMappings = [{ containerPort = 4100, protocol = "tcp" }]
    environment = concat(local.common_environment, [
      { name = "OVO_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "OVO_ECS_CLUSTER", value = aws_ecs_cluster.this.name },
      { name = "OVO_PROTECTION_REQUIRED", value = "true" },
      { name = "OVO_PROTECTION_MODE", value = "ecs" },
      { name = "OVO_CALL_SLOTS", value = "1" },
      { name = "OVO_LIVE_DIAL_ENABLED", value = tostring(var.enable_live_dial) },
      { name = "OVO_TRANSPORT_CERTIFIED", value = tostring(var.transport_certified) },
      { name = "OVO_MEDIA_READINESS_URL", value = var.media_readiness_url },
    ])
    secrets = concat(local.runtime_secrets, [
      { name = "TWILIO_ACCOUNT_SID", valueFrom = "${var.runtime_secret_arn}:TWILIO_ACCOUNT_SID::" },
      { name = "TWILIO_AUTH_TOKEN", valueFrom = "${var.runtime_secret_arn}:TWILIO_AUTH_TOKEN::" },
    ])
    stopTimeout      = 120
    healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 15, timeout = 5, retries = 3, startPeriod = 30 }
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "worker" } }
  }])
}

