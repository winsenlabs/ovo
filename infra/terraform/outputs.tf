output "alb_dns_name" { value = aws_lb.this.dns_name }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "worker_service_name" { value = aws_ecs_service.worker.name }
output "job_queue_url" { value = aws_sqs_queue.jobs.url }
output "job_dlq_url" { value = aws_sqs_queue.jobs_dlq.url }
