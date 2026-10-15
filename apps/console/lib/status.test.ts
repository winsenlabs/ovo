import { describe, expect, it } from 'vitest';
import { humaniseEnum, humaniseKey, statusTone } from './status';

describe('statusTone', () => {
  it('tones running and queued as info, never ok', () => {
    expect(statusTone('running')).toBe('info');
    expect(statusTone('queued')).toBe('info');
    expect(statusTone('in_progress')).toBe('info');
  });
  it('tones cancelled as neutral, not danger', () => {
    expect(statusTone('cancelled')).toBe('neutral');
  });
  it('tones failed as danger', () => {
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('timeout')).toBe('danger');
  });
  it('tones completed and healthy as ok', () => {
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('healthy')).toBe('ok');
  });
  it('normalises case and separators before lookup', () => {
    expect(statusTone('In Progress')).toBe('info');
    expect(statusTone('IN-PROGRESS')).toBe('info');
  });
  it('is neutral, never a silent ok, for an unknown or missing value', () => {
    expect(statusTone('something-new')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
    expect(statusTone(undefined)).toBe('neutral');
  });
});

describe('humaniseEnum', () => {
  it('turns a snake_case value into sentence case', () => {
    expect(humaniseEnum('in_progress')).toBe('In progress');
  });
  it('lowercases short connector words after the first', () => {
    expect(humaniseEnum('promised_to_pay')).toBe('Promised to pay');
  });
  it('collapses a stray separator and extra space', () => {
    expect(humaniseEnum('time of_day')).toBe('Time of day');
  });
  it('keeps a short acronym upper-cased', () => {
    expect(humaniseEnum('STT')).toBe('STT');
  });
  it('is honest about a missing value', () => {
    expect(humaniseEnum(null)).toBe('Unknown');
    expect(humaniseEnum('')).toBe('Unknown');
  });
});

describe('humaniseKey', () => {
  it('splits camelCase before humanising', () => {
    expect(humaniseKey('userSpeechTimeoutMs')).toBe('User speech timeout ms');
  });
});

describe('desk and queue states (Wave 17)', () => {
  it('tones a waiting caller as info, a taken one as ok, an expired one as warn', () => {
    expect(statusTone('waiting')).toBe('info');
    expect(statusTone('offered')).toBe('info');
    expect(statusTone('accepted')).toBe('ok');
    expect(statusTone('expired')).toBe('warn');
    expect(statusTone('released')).toBe('neutral');
  });
  it('tones operator presence: available ok, away warn, offline neutral', () => {
    expect(statusTone('AVAILABLE')).toBe('ok');
    expect(statusTone('AWAY')).toBe('warn');
    expect(statusTone('OFFLINE')).toBe('neutral');
  });
});
