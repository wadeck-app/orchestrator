import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Contract test on the stylesheet text. jsdom never processes @tailwind
// directives and loads no stylesheet, so a getComputedStyle assertion here would
// pass against an empty cascade and prove nothing.
const CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

/** Body of the first rule whose selector matches, with comments stripped. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No rule found for selector "${selector}" in ${CSS_PATH}`);
  return match[1]!.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('theme color-scheme contract', () => {
  // Without color-scheme the UA paints its light-mode scrollbars and form
  // controls regardless of the theme tokens, which is why the dark theme showed
  // a white scrollbar over a #0f1117 page.
  it('declares color-scheme: light on :root', () => {
    expect(ruleBody(':root')).toMatch(/color-scheme:\s*light\s*;/);
  });

  it('declares color-scheme: dark on the dark theme selector', () => {
    expect(ruleBody('[data-theme="dark"]')).toMatch(/color-scheme:\s*dark\s*;/);
  });

  // The two themes must not both claim the same scheme, otherwise one of them
  // gets UA widgets that fight its own tokens.
  it('does not declare the same color-scheme for both themes', () => {
    const light = /color-scheme:\s*(\w+)/.exec(ruleBody(':root'))?.[1];
    const dark = /color-scheme:\s*(\w+)/.exec(ruleBody('[data-theme="dark"]'))?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(light).not.toBe(dark);
  });
});
