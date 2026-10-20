'use client';
import type { RulesMatcher } from '@winsendotai/ovo-contracts';
import { NumberField, optionsFrom, SelectField, TagsField, TextField } from '../../../components/routing/fields';
import { HoursEditor } from '../../../components/routing/hours-editor';

const E164_PREFIX = /^\+[1-9][0-9]{0,14}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const INSIDE = optionsFrom({ inside: 'Inside these hours', outside: 'Outside these hours' });

/** One editor per matcher kind (design 7.3); `id` keeps two matchers' controls apart. */
export function MatcherEditor({
  matcher,
  onChange,
  id,
}: {
  matcher: RulesMatcher;
  onChange: (matcher: RulesMatcher) => void;
  id: string;
}) {
  switch (matcher.kind) {
    case 'dtmf':
      return (
        <TextField
          id={`${id}-digits`}
          label="Digits the caller presses"
          value={matcher.digits}
          mono
          help="0-9, * and # (up to 8)."
          error={/^[0-9*#]{1,8}$/.test(matcher.digits) ? undefined : 'Use 1 to 8 of 0-9, * or #'}
          onChange={(digits) => onChange({ ...matcher, digits })}
        />
      );
    case 'caller-id': {
      const bad = matcher.prefixes.filter((p) => !E164_PREFIX.test(p));
      return (
        <TagsField
          id={`${id}-prefixes`}
          label="Caller numbers start with"
          values={matcher.prefixes}
          placeholder="+9140"
          help="International prefixes, press Enter after each."
          error={bad.length ? `Not international (+ then digits): ${bad.join(', ')}` : undefined}
          onChange={(prefixes) => onChange({ ...matcher, prefixes })}
        />
      );
    }
    case 'time':
      return (
        <>
          <SelectField
            id={`${id}-inside`}
            label="Matches"
            value={matcher.inside ? 'inside' : 'outside'}
            options={INSIDE}
            onChange={(value) => onChange({ ...matcher, inside: value === 'inside' })}
          />
          <HoursEditor
            required
            idPrefix={`${id}-hours`}
            value={matcher.hours}
            onChange={(hours) => hours && onChange({ ...matcher, hours })}
          />
        </>
      );
    case 'variable':
      return (
        <>
          <TextField
            id={`${id}-name`}
            label="Call variable"
            value={matcher.name}
            onChange={(name) => onChange({ ...matcher, name })}
            help="A variable set on the number or the call, like segment."
          />
          <TagsField
            id={`${id}-equals`}
            label="Equals any of"
            values={matcher.equals}
            onChange={(equals) => onChange({ ...matcher, equals })}
          />
        </>
      );
    case 'keywords':
      return (
        <>
          <TagsField
            id={`${id}-words`}
            label="Words to listen for"
            values={matcher.words}
            help="Whole words, anywhere in a short reply."
            onChange={(words) => onChange({ ...matcher, words })}
          />
          <NumberField
            id={`${id}-max`}
            label="Only in replies up to"
            unit="words"
            min={1}
            max={30}
            value={matcher.maxWords}
            onChange={(maxWords) => onChange({ ...matcher, maxWords })}
          />
        </>
      );
    case 'phrases':
      return (
        <TagsField
          id={`${id}-phrases`}
          label="Exact replies"
          values={matcher.phrases}
          help="Compared after lower-casing and dropping punctuation."
          onChange={(phrases) => onChange({ ...matcher, phrases })}
        />
      );
    case 'script': {
      const bad = matcher.languages.filter((l) => !LANGUAGE.test(l));
      return (
        <TagsField
          id={`${id}-languages`}
          label="Reply is mostly written in a script used by"
          values={matcher.languages}
          placeholder="hi"
          error={bad.length ? `Not a language code: ${bad.join(', ')}` : undefined}
          help="Devanagari matches hi or mr, Tamil matches ta, and so on."
          onChange={(languages) => onChange({ ...matcher, languages })}
        />
      );
    }
  }
}
