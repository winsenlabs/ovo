import { describe, expect, it } from 'vitest';
import { configurationDiff } from '../components/studio/release-diff';
import { diagnoseScript } from '../components/studio/script-editor';
import { bindDiscoveredMcpTool } from '../components/integrations/mcp-agent-config';
import { emptyAgentConfig } from '../lib/api';
import {
  parseFollowUpInputs,
  simulationRequest,
} from '../components/operations/simulation-request';
import { parseEvaluationCorpus } from '../components/operations/evaluation-import';
import {
  inboundRoutePath,
  parseInboundRouteVariables,
} from '../components/operations/inbound-route-state';
import { recordingTrackEvidence } from '../components/operations/production-track-player';
import {
  activeProviderAuthorizations,
  providerRunAuthorization,
} from '../components/operations/evaluation-provider-state';
import { carrierOperatorUrls } from '../components/plugins/binding-select';
import { pluginOptionsForSlot } from '../components/plugins/types';
import { readinessIssueHref } from '../components/studio/release-panels';

describe('wave-2 plugin and readiness API shapes', () => {
  it('filters installed manifest projections by the requested slot, retaining unavailable choices', () => {
    const plugins = [
      { id: 'engine-one', kind: 'engine', version: '1', available: true },
      {
        id: 'carrier-one',
        kind: 'carrier',
        version: '1',
        available: false,
        unavailableReason: 'Native codec unavailable',
      },
    ];
    expect(pluginOptionsForSlot(plugins, 'carrier')).toEqual([plugins[1]]);
    expect(pluginOptionsForSlot(plugins, 'turnDetector')).toEqual([]);
  });

  it('uses the API carrier URL items envelope and fails closed on malformed rows', () => {
    const answer = {
      purpose: 'answer',
      label: 'Answer URL',
      url: 'https://fixture.test/answer?t=opaque',
    };
    expect(carrierOperatorUrls({ items: [answer] })).toEqual([answer]);
    expect(() => carrierOperatorUrls({ items: [{ purpose: 'answer' }] })).toThrow(
      'Carrier URL response is invalid',
    );
    expect(() => carrierOperatorUrls({ answerUrl: answer.url })).toThrow(
      'Carrier URL response is invalid',
    );
  });

  it('links a readiness detail to its exact agent slot', () => {
    expect(readinessIssueHref('agent/one', 'carrier')).toBe(
      '/agents/agent%2Fone/plugins#slot-carrier',
    );
  });
});

describe('release configuration comparison', () => {
  it('reports stable paths without changing either snapshot', () => {
    const released = { mode: 'faq', providers: { stt: 'binding-a' }, faq: [{ id: 'one' }] };
    const draft = { mode: 'faq', providers: { stt: 'binding-b' }, faq: [{ id: 'two' }] };
    expect(configurationDiff(released, draft)).toEqual([
      { path: 'faq', before: [{ id: 'one' }], after: [{ id: 'two' }] },
      { path: 'providers.stt', before: 'binding-a', after: 'binding-b' },
    ]);
    expect(released.providers.stt).toBe('binding-a');
  });
});

describe('accessible script diagnostics', () => {
  it('accepts a reachable bounded text and DTMF graph', () => {
    expect(
      diagnoseScript({
        start: 'welcome',
        maxVisits: 10,
        nodes: [
          {
            id: 'welcome',
            prompt: 'Press 1 or say continue.',
            terminal: false,
            transitions: [
              { event: 'dtmf', matches: ['1'], to: 'done' },
              { event: 'text', matches: ['continue'], to: 'done' },
            ],
          },
          { id: 'done', prompt: 'Thank you.', terminal: true, transitions: [] },
        ],
      }),
    ).toEqual([]);
  });

  it('surfaces missing, unreachable, terminal and DTMF problems', () => {
    const issues = diagnoseScript({
      start: 'missing',
      maxVisits: 10,
      nodes: [
        {
          id: 'only',
          prompt: '',
          terminal: true,
          transitions: [{ event: 'dtmf', matches: ['12'], to: 'absent' }],
        },
      ],
    });
    expect(issues).toContain('The start node does not exist.');
    expect(issues).toContain('only needs a prompt.');
    expect(issues).toContain('only is terminal but still has transitions.');
    expect(issues).toContain('only points to missing node absent.');
    expect(issues).toContain('only has an invalid DTMF match.');
    expect(issues).toContain('only is unreachable.');
  });
});

describe('MCP approval draft binding', () => {
  it('adds the exact discovered schema and confirmation policy to AgentConfig', () => {
    const next = bindDiscoveredMcpTool(
      emptyAgentConfig(),
      { id: 'connection-1', label: 'CRM', endpoint: 'https://mcp.example.test', auth: 'none' },
      {
        id: 'create-ticket',
        remoteName: 'create_ticket',
        schemaDigest: 'sha256:exact',
        inputSchema: { type: 'object', required: ['subject'] },
        effect: 'write',
      },
    );
    expect(next.allowedTools).toEqual(['create-ticket']);
    expect(next.tools[0]).toMatchObject({
      id: 'create-ticket',
      connectionId: 'connection-1',
      remoteName: 'create_ticket',
      schemaDigest: 'sha256:exact',
      confirmation: true,
    });
  });
});

describe('simulation safety mode', () => {
  it('sends fixture bindings, including the safe empty binding object, by default', () => {
    expect(simulationRequest('release-1', 'hello', 'fixture', {})).toEqual({
      releaseId: 'release-1',
      input: 'hello',
      variables: {},
      bindings: {},
    });
  });

  it('omits bindings only for explicit provider-backed execution', () => {
    expect(simulationRequest('release-1', 'hello', 'provider', {})).toEqual({
      releaseId: 'release-1',
      input: 'hello',
      variables: {},
    });
  });

  it('includes bounded follow-up turns in one immutable simulation', () => {
    const followUps = parseFollowUpInputs('confirm\n\n1\n');
    expect(simulationRequest('release-1', 'hello', 'fixture', {}, followUps)).toMatchObject({
      bindings: {},
      followUpInputs: ['confirm', '1'],
    });
    expect(() => parseFollowUpInputs(Array.from({ length: 20 }, () => 'next').join('\n'))).toThrow(
      'at most 19',
    );
  });
});

describe('production evaluation corpus import', () => {
  it('accepts the complete bounded 120-case object form', () => {
    const cases = Array.from({ length: 120 }, (_, index) => ({ id: `case-${index + 1}` }));
    expect(parseEvaluationCorpus(JSON.stringify({ cases }))).toHaveLength(120);
  });

  it('rejects corpora beyond the operator import bound', () => {
    const cases = Array.from({ length: 121 }, (_, index) => ({ id: `case-${index + 1}` }));
    expect(() => parseEvaluationCorpus(JSON.stringify(cases))).toThrow('between 1 and 120');
  });
});

describe('inbound number route authoring', () => {
  it('accepts only string-valued release variables', () => {
    expect(parseInboundRouteVariables('{"language":"en-IN","campaign":"support"}')).toEqual({
      language: 'en-IN',
      campaign: 'support',
    });
    expect(() => parseInboundRouteVariables('["not","an","object"]')).toThrow('JSON object');
    expect(() => parseInboundRouteVariables('{"attempt":2}')).toThrow('must be a string');
  });

  it('encodes the E.164 route key without losing the plus sign', () => {
    expect(inboundRoutePath('+919876543210')).toBe('/operations/inbound/routes/%2B919876543210');
  });
});

describe('production recording track evidence', () => {
  it('keeps unavailable and missing segment sequences visible', () => {
    expect(
      recordingTrackEvidence(
        'available',
        [
          { track: 'inbound', sequence: 1, state: 'available', bytes: 80, startMs: 0, endMs: 10 },
          { track: 'inbound', sequence: 3, state: 'failed', bytes: 0, startMs: 20, endMs: 30 },
          { track: 'outbound', sequence: 1, state: 'available', bytes: 80, startMs: 0, endMs: 10 },
        ],
        'inbound',
      ),
    ).toEqual({ available: 1, total: 2, partial: true, gapCount: 3, gapSequences: [0, 2, 3] });
  });
});

describe('provider evaluation authorization selection', () => {
  const active = {
    id: 'authorization-1',
    workspaceId: 'single-org',
    releaseId: 'release-1',
    releaseFingerprint: 'release-fingerprint',
    bindingVersion: 'binding-1:2026-09-20T00:00:00.000Z',
    provider: 'openai',
    modelId: 'model-1',
    budgetId: 'budget-1',
    maximumReservationPaise: '5000',
    createdBy: 'admin',
    createdAt: '2026-09-20T00:00:00.000Z',
  };

  it('selects only active authorizations for the exact immutable release', () => {
    expect(
      activeProviderAuthorizations(
        [
          active,
          { ...active, id: 'revoked', revokedAt: '2026-09-20T01:00:00.000Z' },
          { ...active, id: 'other-release', releaseId: 'release-2' },
        ],
        'release-1',
      ),
    ).toEqual([active]);
  });

  it('derives the run binding version from the durable authorization', () => {
    expect(providerRunAuthorization([active], 'release-1', active.id)).toEqual({
      providerBindingVersion: active.bindingVersion,
      budgetAuthorizationId: active.id,
    });
    expect(() => providerRunAuthorization([active], 'release-2', active.id)).toThrow(
      'active authorization',
    );
  });
});
