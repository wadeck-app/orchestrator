import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Contract tests on stylesheet text. jsdom never processes @tailwind directives
// and loads no stylesheet, so a getComputedStyle assertion here would pass
// against an empty cascade and prove nothing.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const appCss = fs.readFileSync(path.join(HERE, 'index.css'), 'utf8');
const themeCss = fs.readFileSync(
  path.resolve(HERE, '../../../node_modules/@wadeck-app/dsl-ui/src/theme.css'),
  'utf8',
);

/**
 * Declarations of the first rule whose selector list matches.
 *
 * Searches the stylesheet with comments already removed. It used to strip them only from the
 * captured body, so a comment that merely MENTIONED a selector was matched before the rule itself:
 * a sentence in dsl-ui's theme.css explaining that an inner light scope beats an outer dark one made
 * this return the light block when asked for the dark one, and the assertion failed against a file
 * that was entirely correct.
 */
function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`).exec(withoutComments);
  if (!match) {
    throw new Error(`No rule matching "${selector}"`);
  }
  return match[1]!;
}

function tokensIn(body: string): Set<string> {
  return new Set([...body.matchAll(/(--color-[\w-]+)\s*:/g)].map(m => m[1]!));
}

describe('app theme wiring', () => {
  // The whole point of adopting the design system: the palette has exactly one
  // definition, and it is dsl-ui's. Imported from the JS entry, because Vite
  // resolves bare specifiers in CSS @import without reading the exports map.
  it('imports the shared palette instead of restating it', () => {
    const mainTsx = fs.readFileSync(path.join(HERE, 'main.tsx'), 'utf8');
    expect(mainTsx).toMatch(/import\s+'@wadeck-app\/dsl-ui\/theme\.css'/);
    // Before index.css, so the app's own tokens layer on top rather than under.
    expect(mainTsx.indexOf('dsl-ui/theme.css')).toBeLessThan(mainTsx.indexOf('./index.css'));
  });

  it('leaves every generic token to dsl-ui', () => {
    const appTokens = new Set([
      ...tokensIn(ruleBody(appCss, ':root')),
      ...tokensIn(ruleBody(appCss, '[data-theme="dark"]')),
    ]);
    // Redefining these locally is what made this app drift last time.
    const owned = ['--color-primary', '--color-bg', '--color-surface', '--color-border',
      '--color-content', '--color-muted', '--color-muted-bg', '--color-success',
      '--color-danger', '--color-warning'];
    expect(owned.filter(t => appTokens.has(t))).toEqual([]);
  });

  // color-scheme is what makes the UA paint theme-matching scrollbars. It now
  // arrives with the shared palette, so the app must not need its own copy - but
  // it still has to be reachable, or the white-scrollbar bug returns.
  it('gets color-scheme from the shared palette, both themes', () => {
    expect(ruleBody(themeCss, ':root')).toMatch(/color-scheme:\s*light\s*;/);
    expect(ruleBody(themeCss, '.dark')).toMatch(/color-scheme:\s*dark\s*;/);
  });

  it('relies on the shared palette matching this app\'s dark-mode selector', () => {
    // This app switches themes with [data-theme="dark"]; dsl-ui's own switch uses
    // a .dark class. theme.css has to match both or the app has no dark palette.
    expect(themeCss).toMatch(/\[data-theme='dark'\]/);
  });

  // Tokens the design system has no equivalent for still have to be defined for
  // both themes, or the second theme silently falls back to the first.
  it('defines its own tokens in both themes', () => {
    const light = tokensIn(ruleBody(appCss, ':root'));
    const dark = tokensIn(ruleBody(appCss, '[data-theme="dark"]'));
    expect([...light].filter(t => !dark.has(t))).toEqual([]);
    expect([...dark].filter(t => !light.has(t))).toEqual([]);
  });
});
