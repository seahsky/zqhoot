import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AXE_TAGS, DISABLED_RULES } from '../e2e/helpers.ts';

/** The gallery suite's tags and rule list, so a live screen is held to the same standard. */
export async function expectNoAxeViolations(page: Page, what: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .disableRules(DISABLED_RULES.map((r) => r.id))
    .analyze();
  const report = results.violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n');
  expect(results.violations, `axe on ${what}\n${report}`).toEqual([]);
}
