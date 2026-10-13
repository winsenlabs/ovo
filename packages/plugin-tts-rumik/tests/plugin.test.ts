import { Cap, MULAW_8K, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { RumikTts, rumikTtsPlugin } from '../src/index.ts';
import {
  FIXTURE_DESCRIPTION,
  fixtureAudio,
  generationSteps,
  mintSteps,
  socketOpen,
} from '../src/testing.ts';
import { drain, script, sent, ttsInput } from './support.ts';

it('composes with a credential reference and closes its socket when the session ends', async () => {
  const resolve = vi.fn(async () => 'fixture-key');
  const host = definePlugin(
    {
      id: 'fixture-secret-resolver',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [Cap.secrets],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, { resolve });
    },
  );
  const text = 'Namaste.';
  const net = createFixtureNet([
    script([
      ...mintSteps(MULAW_8K),
      socketOpen(),
      ...generationSteps(text, MULAW_8K, 1),
      sent({ type: 'close' }),
    ]),
  ]);
  const parent = await compose([{ id: host.manifest.id }], [host], { scope: 'process' });
  try {
    const composition = await compose(
      [
        {
          id: rumikTtsPlugin.manifest.id,
          config: {
            binding: { description: FIXTURE_DESCRIPTION },
            credentialRef: { credentialRef: { credentialId: 'cred-rumik' } },
          },
        },
      ],
      [rumikTtsPlugin],
      { scope: 'session', parent, workspaceId: 'workspace-1', net },
    );
    const tts = composition.get(Cap.tts) as TextToSpeech;
    expect(tts).toBeInstanceOf(RumikTts);
    expect(await drain(tts.synthesize({ ...ttsInput(), text }))).toEqual([
      ...fixtureAudio(MULAW_8K, text, 1),
    ]);
    await composition.dispose();
  } finally {
    await parent.dispose();
  }
  expect(resolve).toHaveBeenCalledWith('workspace-1', 'cred-rumik');
  expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
  net.assertComplete();
});
