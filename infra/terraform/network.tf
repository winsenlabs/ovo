resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public TLS ingress only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_security_group" "application" {
  name        = "${local.name}-application"
  description = "Private OVO application tasks"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "One-slot call workers"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "application_from_alb" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 4001
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "worker_from_gateway" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.application.id
  from_port                    = 4100
  to_port                      = 4100
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "application_https" {
  security_group_id = aws_security_group.application.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "application_dns_udp" {
  security_group_id = aws_security_group.application.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "application_dns_tcp" {
  security_group_id = aws_security_group.application.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_dns_udp" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "worker_dns_tcp" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_worker" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 4100
  to_port                      = 4100
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "application_postgres" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = var.database_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_postgres" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = var.database_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_application" {
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.application.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_worker" {
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_lb" "this" {
  name               = substr(local.name, 0, 32)
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  idle_timeout       = var.alb_idle_timeout_seconds
}

resource "aws_lb_target_group" "console" {
  name        = substr("${local.name}-console", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/"
    matcher = "200-399"
  }
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api", 0, 32)
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/health"
    matcher = "200-399"
  }
}

resource "aws_lb_target_group" "gateway" {
  name                 = substr("${local.name}-gateway", 0, 32)
  port                 = 4001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 300
  health_check {
    path    = "/health"
    matcher = "200-399"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.console.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/health"] }
  }
}

resource "aws_lb_listener_rule" "gateway" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
  condition {
    path_pattern { values = ["/media/*", "/callbacks/twilio/*", "/voice/inbound/*"] }
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${local.name}.internal"
  vpc  = var.vpc_id
}

resource "aws_service_discovery_service" "worker" {
  name = "worker"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
}
