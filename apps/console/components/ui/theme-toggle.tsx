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
const CHANGE_EVENT = 'ovo:theme-changed';

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>('system');
  useEffect(() => setPreference(readStored()), []);
  // Two instances render at once (topbar + Account's Appearance card). The native `storage`
  // event only reaches *other* tabs, never the tab that made the change, so picking Dark in one
  // instance left every other instance on screen still showing System (brief defect #17). This
  // custom same-tab event, plus `storage` for other tabs/windows, keeps every instance in sync.
  useEffect(() => {
    const sync = () => setPreference(readStored());
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    apply(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore: a blocked/private storage context still gets the visual change this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
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
          aria-label={`${option.charAt(0).toUpperCase()}${option.slice(1)} theme`}
        >
          {option === 'system' ? '◐' : option === 'light' ? '☀' : '☾'}
        </button>
      ))}
    </div>
  );
}

/** Source for the blocking inline script `app/layout.tsx` runs in `<head>` before paint. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var v=localStorage.getItem('${STORAGE_KEY}');if(v==='light'||v==='dark'){document.documentElement.dataset.theme=v;}}catch(e){}})();`;
