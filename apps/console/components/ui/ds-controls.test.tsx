import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from './theme-toggle';
import { RadioCardGroup } from './choice-card';
import { DateRangePicker } from './toolbar';

afterEach(() => cleanup());

describe('ThemeToggle', () => {
  it('gives each option an accessible name beyond its glyph', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toBeTruthy();
  });
});

describe('RadioCardGroup', () => {
  it('names the group so assistive tech announces more than a bare set of radios', () => {
    render(
      <RadioCardGroup
        name="demo"
        groupLabel="Agent mode"
        value="a"
        onChange={() => undefined}
        choices={[{ value: 'a', title: 'A' }]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Agent mode' })).toBeTruthy();
  });
});

describe('DateRangePicker', () => {
  it('offers date inputs once "Custom" is selected instead of a dead end', () => {
    render(
      <DateRangePicker
        value="custom"
        onChange={() => undefined}
        custom={{ from: '', to: '' }}
        onCustomChange={() => undefined}
      />,
    );
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.getByText('To')).toBeTruthy();
  });
  it('does not show date inputs for a preset other than custom', () => {
    render(<DateRangePicker value="24h" onChange={() => undefined} />);
    expect(screen.queryByText('From')).toBeNull();
  });
  it('fires onChange when a preset button is clicked', () => {
    let selected = '24h';
    render(<DateRangePicker value="24h" onChange={(preset) => (selected = preset)} />);
    fireEvent.click(screen.getByRole('radio', { name: '7d' }));
    expect(selected).toBe('7d');
  });
});
