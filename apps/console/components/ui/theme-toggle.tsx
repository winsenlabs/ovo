'use client';
import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'ovo-console-theme';

function apply(preference: ThemePreference) {
  try {
    document.documentElement.dataset.theme = preference === 'system' ? '' : preference;
  } catch {
    // Ignore: theming is a cosmetic enhancement, never load-bearing.
  }
}

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * System/light/dark toggle for the topbar. Pair with the inline bootstrap script in
 * `app/layout.tsx`, which sets `data-theme` before paint so there is no flash of the wrong theme.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>('system');
  useEffect(() => setPreference(readStored()), []);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    apply(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore: a blocked/private storage context still gets the visual change this session.
    }
  };

  return (
    <div className="ds-theme-toggle" role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={preference === option}
          className={preference === option ? 'selected' : ''}
          onClick={() => choose(option)}
          title={`${option.charAt(0).toUpperCase()}${option.slice(1)} theme`}
        >
          {option === 'system' ? '◐' : option === 'light' ? '☀' : '☾'}
        </button>
      ))}
    </div>
  );
}

/** Source for the blocking inline script `app/layout.tsx` runs in `<head>` before paint. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var v=localStorage.getItem('${STORAGE_KEY}');if(v==='light'||v==='dark'){document.documentElement.dataset.theme=v;}}catch(e){}})();`;
