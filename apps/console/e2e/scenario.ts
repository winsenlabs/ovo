import { expect, type Page } from '@playwright/test';
import { noOverflowOrAxe, signedIn } from './helpers';

export type Scenario = 'rich' | 'empty' | 'down' | 'disabled';

/**
 * Sign in and pick a fixture scenario served by e2e/auth-server.mjs (`ovo_fixture` cookie), and
 * collect page and console errors. The `down` scenario answers 503 on purpose, so the browser's
 * own "failed to load" line for it is not a problem.
 */
export async function scenarioPage(
  page: Page,
  scenario: Scenario,
  role: 'admin' | 'editor' | 'viewer' = 'admin',
) {
  await signedIn(page, role);
  await page
    .context()
    .addCookies([{ name: 'ovo_fixture', value: scenario, domain: '127.0.0.1', path: '/' }]);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/status of 50[0-9]|status of 404|ERR_|Failed to load resource/.test(message.text())
    )
      problems.push(`console: ${message.text()}`);
  });
  return problems;
}

/** Capture the screen and sweep it for overflow and axe in light and dark. */
export async function sweepScreen(
  page: Page,
  name: string,
  projectName: string,
  problems: string[],
) {
  // A client-side navigation can leave the document untitled for a frame; axe would flag that.
  await expect(page).toHaveTitle(/.+/);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // Re-checked right before axe: a tab change can blank the title again after the first check.
    await expect.poll(() => page.title()).not.toBe('');
    await noOverflowOrAxe(page);
    await page.screenshot({
      path: `test-results/captures/${name}-${scheme}-${projectName}.png`,
      fullPage: true,
    });
  }
  expect(problems).toEqual([]);
}
