import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAgentConfig } from '../lib/api';
import { StudioRail } from './studio/release-panels';

afterEach(cleanup);
const selected = { id: 'agent-1', draftVersion: '2', config: emptyAgentConfig() };

describe('release readiness detail', () => {
  it('renders slot and stage blockers with a link to the corrective plugin control', () => {
    render(<StudioRail selected={selected} releases={[]} extensions={[]} readiness={{ releaseReady: false, requiredPluginIds: [], blockers: ['Carrier format is incompatible'], details: [{ code: 'format_unreachable', stage: 'release', severity: 'error', slot: 'carrier', message: 'Pick another carrier' }], liveReady: false, liveBlockers: [] }} />);
    expect(screen.getByText('Carrier format is incompatible')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Pick another carrier' }).getAttribute('href')).toBe('/agents/agent-1/plugins#slot-carrier');
  });

  it('does not claim live readiness from release readiness alone', () => {
    render(<StudioRail selected={selected} releases={[]} extensions={[]} readiness={{ releaseReady: true, requiredPluginIds: [], blockers: [], details: [], liveReady: false, liveBlockers: ['No capacity'] }} />);
    expect(screen.getByText('No capacity')).toBeDefined();
  });
});
