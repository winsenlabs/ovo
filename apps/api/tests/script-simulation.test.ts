import { expect, it } from 'vitest';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { buildManagementApi } from '../src/server.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

it('keeps script state across simulated turns and stops after confirmed terminal playback', async () => {
  const { app, composition } = await buildManagementApi({
    databaseFile: ':memory:',
    secretBackend: 'local',
    sessionSecret: 'script-fixture-session',
    secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
    pluginCatalog: [selectedSpeechFixture],
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'script-fixture-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer script-fixture-token' },
      payload: payload as Record<string, unknown>,
    });
  try {
    const agent = await post('/v1/agents', {
      config: {
        name: 'Multi-turn script',
        mode: 'faq',
        faq: [{ id: 'hours', question: 'opening hours', answer: 'Nine to five.' }],
        voice: selectedSpeechVoice,
        script: {
          start: 'start',
          nodes: [
            {
              id: 'start',
              prompt: 'Say continue.',
              transitions: [{ event: 'text', matches: ['continue'], to: 'done' }],
            },
            { id: 'done', prompt: 'Thank you.', terminal: true },
          ],
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const release = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    const simulation = await post('/v1/simulations', {
      releaseId: release.json().id,
      input: 'start',
      followUpInputs: ['opening hours', 'continue', 'must not execute'],
      bindings: {},
    });
    expect(simulation.statusCode, simulation.body).toBe(200);
    expect(simulation.json().output).toBe('Thank you.');
    const store = composition.ctx.get('controlStore') as ControlStore;
    const events = await store.listCallEvents('local', simulation.json().callId, 50);
    expect(
      events.items
        .filter((event) => event.type === 'simulation.output')
        .map((event) => event.payload.text),
    ).toEqual(['Say continue.', 'Nine to five. Say continue.', 'Thank you.']);
    expect(events.items.some((event) => event.payload.input === 'must not execute')).toBe(false);
  } finally {
    await composition.dispose();
  }
});
