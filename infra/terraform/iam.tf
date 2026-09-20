resource "aws_iam_role" "execution" {
  name = "${local.name}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.runtime_secret_arn] }]
  })
}

resource "aws_iam_role" "api" {
  name = "${local.name}-api"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role" "console" {
  name               = "${local.name}-console"
  assume_role_policy = aws_iam_role.api.assume_role_policy
}

resource "aws_iam_role" "gateway" {
  name               = "${local.name}-gateway"
  assume_role_policy = aws_iam_role.api.assume_role_policy
}

resource "aws_iam_role" "dispatcher" {
  name               = "${local.name}-dispatcher"
  assume_role_policy = aws_iam_role.api.assume_role_policy
}

resource "aws_iam_role_policy" "dispatcher" {
  role = aws_iam_role.dispatcher.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PublishDurableJobReferences"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.jobs.arn]
      },
      {
        Sid      = "OnlyDesiredCountWriter"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = [local.worker_service_arn]
      },
      {
        Sid       = "PublishCapacityEvidence"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "OVO/Capacity" } }
      }
    ]
  })
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = aws_iam_role.api.assume_role_policy
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConsumeDurableJobs"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.jobs.arn]
      },
      {
        Sid       = "ProtectWorkerTasks"
        Effect    = "Allow"
        Action    = ["ecs:UpdateTaskProtection"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      }
    ]
  })
}

