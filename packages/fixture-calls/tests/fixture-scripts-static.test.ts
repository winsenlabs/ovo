import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { selectFixtureScripts } from '../src/fixture-scripts.ts';
import { input } from './support.ts';

describe('fixture script selection', () => {
  it('selects static STT without a template when playback gating is absent', () => {
    const base = input();
    const sttId = base.release.selections.stt.pluginId;
    const staticScript = {
      host: 'fixture.invalid',
      source: 'https://fixture.invalid/docs/stt',
      retrieved: '2026-09-25',
      steps: [],
    };
    const selected = selectFixtureScripts(
      {
        ...base,
        fixtureTemplates: Object.fromEntries(
          Object.entries(base.fixtureTemplates).filter(([id]) => id !== sttId),
        ),
        fixtures: { ...base.fixtures, [sttId]: [staticScript] },
      },
      base.release.selections,
      base.callerScript,
      MULAW_8K,
      'static-stt-session',
      'en-US',
      [],
    );
    expect(selected.sttMode).toBe('static');
    expect(selected.scripts).toContain(staticScript);
  });
});
