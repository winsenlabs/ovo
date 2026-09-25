import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPACITY_METRIC_NAMES } from '../../packages/contracts/src/ops/capacity-signal.ts';

const directory = new URL('.', import.meta.url).pathname;
const tf = (name: string) => readFileSync(join(directory, name), 'utf8');
const all = readdirSync(directory).filter((name) => name.endsWith('.tf')).map(tf).join('\n');

function block(source: string, kind: string, name: string): string {
  const start = source.indexOf(`${kind} "${name}"`);
  if (start < 0) throw new Error(`Missing ${kind} ${name}`);
  let depth = 0;
  const open = source.indexOf('{', start);
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${kind} ${name}`);
}

describe('Fargate scaling contract', () => {
  it('has no ECS desired-count writer and uses AAS as the only scaling target', () => {
    expect(all).not.toContain('ecs:UpdateService');
    expect(block(tf('autoscaling.tf'), 'resource "aws_appautoscaling_target"', 'worker')).toContain('ecs:service:DesiredCount');
    expect(tf('services.tf')).toContain('ignore_changes = [desired_count]');
    expect(tf('autoscaling.tf')).toContain('IF(prov>0,req/prov,req)');
    expect(tf('autoscaling.tf')).toContain('period      = 10');
    expect(tf('autoscaling.tf')).toContain('aws_appautoscaling_scheduled_action');
  });

  it('limits dispatcher IAM to Describe, PutMetricData and queue actions', () => {
    const dispatcher = block(tf('iam.tf'), 'resource "aws_iam_role_policy"', 'dispatcher');
    const actions = [...dispatcher.matchAll(/"((?:ecs|cloudwatch|sqs):[A-Za-z]+)"/g)]
      .map((match) => match[1]).filter((action) => action !== 'cloudwatch:namespace');
    expect(new Set(actions)).toEqual(new Set([
      'sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage',
      'sqs:DeleteMessage', 'ecs:DescribeServices', 'cloudwatch:PutMetricData',
    ]));
    expect(dispatcher).toContain('cloudwatch:namespace');
    expect(dispatcher).toContain(CAPACITY_METRIC_NAMES.namespace);
    expect(tf('iam.tf')).toContain('ecs:GetTaskProtection');
  });

  it('uses the contracted high-resolution capacity metrics and alarms', () => {
    const capacity = tf('autoscaling.tf') + tf('alarms.tf');
    for (const name of [CAPACITY_METRIC_NAMES.namespace, CAPACITY_METRIC_NAMES.required,
      CAPACITY_METRIC_NAMES.provisioned, CAPACITY_METRIC_NAMES.oldestAge]) expect(capacity).toContain(name);
    expect(tf('alarms.tf')).toContain('statistic           = "SampleCount"');
    expect(tf('alarms.tf')).toContain('treat_missing_data  = "breaching"');
    for (const name of ['jobs_dlq', 'oldest_eligible_job', 'target_health', 'protection_renewal_failed', 'job_queue_age', 'hint_exhausted']) {
      expect(block(tf('alarms.tf'), 'resource "aws_cloudwatch_metric_alarm"', name)).toContain('var.alarm_topic_arn');
    }
  });

  it('has ALB and console-to-API egress and two gateway replicas', () => {
    expect(block(tf('network.tf'), 'resource "aws_vpc_security_group_egress_rule"', 'alb_to_application')).toContain('to_port                      = 4001');
    expect(block(tf('network.tf'), 'resource "aws_vpc_security_group_egress_rule"', 'application_to_api')).toContain('to_port                      = 4000');
    expect(tf('network.tf')).toContain('"/carriers/*"');
    expect(tf('network.tf')).toContain('"/twilio/*"');
    expect(tf('variables.tf')).toContain('default     = 2');
    expect(tf('variables.tf')).not.toContain('gateway_desired_count == 1');
    expect(tf('network.tf')).toContain('min(3600, var.max_call_seconds)');
  });

  it('provides API secrets, proxy and carrier URLs without fixture calls on Fargate', () => {
    const api = block(tf('tasks.tf'), 'resource "aws_ecs_task_definition"', 'api');
    for (const key of ['OVO_SESSION_SECRET', 'OVO_SEED_ADMIN_EMAIL', 'OVO_SEED_ADMIN_PASSWORD', 'OVO_TRUSTED_PROXY_CIDRS', 'OVO_MEDIA_PUBLIC_BASE_URL', 'OVO_INBOUND_ROUTE_SECRET', 'OVO_CARRIER_ENV_BINDINGS']) {
      expect(api).toContain(key);
    }
    expect(tf('tasks.tf')).not.toContain('OVO_FIXTURE_TEST_CALLS');
    expect(tf('tasks.tf')).not.toContain('OVO_CAPACITY_AUTHORITY');
    expect(tf('tasks.tf')).not.toContain('OVO_DISPATCHER_ID');
  });

  it('selects the Fargate distribution profile in every task', () => {
    expect(tf('main.tf')).toContain('{ name = "OVO_DEPLOYMENT_PROFILE", value = "fargate" }');
    for (const name of ['api', 'console', 'gateway', 'dispatcher', 'worker'])
      expect(block(tf('tasks.tf'), 'resource "aws_ecs_task_definition"', name))
        .toContain('environment = concat(local.common_environment, [');
  });

  it('passes explicit carrier, provider and spend ceilings to the dispatcher', () => {
    const dispatcher = block(tf('tasks.tf'), 'resource "aws_ecs_task_definition"', 'dispatcher');
    for (const [key, variable] of [
      ['OVO_CARRIER_CONCURRENCY', 'carrier_concurrency'],
      ['OVO_PROVIDER_CONCURRENCY', 'provider_concurrency'],
      ['OVO_SPEND_PERMITTED_STARTS', 'spend_permitted_starts'],
    ]) expect(dispatcher).toContain(`{ name = "${key}", value = tostring(var.${variable}) }`);
  });

  it('provides every required variable in the example and S3 state locking', () => {
    const vars = tf('variables.tf');
    const example = tf('terraform.tfvars.example');
    const starts = [...vars.matchAll(/variable "([^"]+)"\s*\{/g)];
    for (const [index, match] of starts.entries()) {
      const body = vars.slice(match.index, starts[index + 1]?.index ?? vars.length);
      if (!/\bdefault\s*=/.test(body)) expect(example).toMatch(new RegExp(`^${match[1]}\\s*=`, 'm'));
    }
    expect(tf('versions.tf')).toContain('backend "s3" {}');
    expect(tf('versions.tf')).toContain('>= 1.10.0');
    expect(readFileSync(join(directory, 'backend.hcl.example'), 'utf8')).toContain('use_lockfile = true');
    expect(tf('main.tf')).toContain('maxReceiveCount     = 10');
  });
});
