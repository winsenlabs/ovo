import { expect, type Page, type TestInfo } from '@playwright/test';
import { noOverflowOrAxe, signedIn } from './helpers';

/**
 * Shared by the call inspector, calls list and routing evaluation specs (Wave 18): sign in, pick
 * the fixture scenario, and sweep a screen in light and dark for overflow, axe and page errors.
 * `inspector` turns on the fixture routes shared with the routing lane (`nooutcomes` makes the
 * calls list say it cannot apply routing filters).
 */
export type Scenario = 'rich' | 'empty' | 'down' | 'disabled';
const SCHEMES = ['light', 'dark'] as const;

export async function arrange(page: Page, scenario: Scenario, inspector = '1') {
  await signedIn(page);
  await page.context().addCookies([
    { name: 'ovo_fixture', value: scenario, domain: '127.0.0.1', path: '/' },
    { name: 'ovo_inspector', value: inspector, domain: '127.0.0.1', path: '/' },
  ]);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // The `down` scenario answers 503 on purpose; the browser logs each failed load.
    if (
      message.type() === 'error' &&
      !/status of (503|404)|ERR_|Failed to load resource/.test(message.text())
    )
      problems.push(`console: ${message.text()}`);
  });
  return problems;
}

export async function sweep(page: Page, name: string, info: TestInfo, problems: string[]) {
  // A client navigation (a filter written to the URL) briefly leaves the document untitled.
  await expect(page).toHaveTitle(/.+/);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await noOverflowOrAxe(page);
    await page.screenshot({
      path: `test-results/captures/${name}-${scheme}-${info.project.name}.png`,
      fullPage: true,
    });
  }
  expect(problems).toEqual([]);
}
