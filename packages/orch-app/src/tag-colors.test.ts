import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Same guard as dsl-lib-orch/test/tag-colors.test.ts, for this app's own stylesheet and tailwind config
 * (dsl-lib-orch must not know the SPA, so the check cannot live in one place). The tags a user adds to a job are drawn as pills whose colours come from JobCard's TAG_BG / TAG_TEXT
 * classes. Both used to resolve to the SAME custom property, so every tag was a solid block with text of
 * exactly its own colour. These tests resolve the classes the way the browser will (class -> tailwind
 * colour -> custom property -> value in the light or the dark scope) and check the contrast, so a palette
 * edit cannot make the tags unreadable again.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../../dsl-lib-orch');
const appPkg = path.resolve(here, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8');

const jobCardSource = read(path.join(pkg, 'src/components/JobCard.tsx'));

interface Target { name: string; css: string; tailwind: string; dark: string }
const TARGETS: Target[] = [
  { name: 'orch-app', css: path.join(appPkg, 'src/index.css'), tailwind: path.join(appPkg, 'tailwind.config.ts'), dark: '[data-theme="dark"]' },
];

function classList(constName: string): string[] {
  const m = new RegExp(`const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(jobCardSource);
  if (m === null) {
    throw new Error(`JobCard.tsx no longer declares "const ${constName} = [...]": update test/tag-colors.test.ts to where the tag classes live now.`);
  }
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!);
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function scope(css: string, selector: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[;}])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(withoutComments);
  if (m === null) {
    throw new Error(`No "${selector} { ... }" rule found: update test/tag-colors.test.ts to the scopes the stylesheet uses.`);
  }
  const vars = new Map<string, string>();
  for (const d of m[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(d[1]!, d[2]!.trim());
  }
  return vars;
}

/** `'tag-1': 'var(--color-tag-1)'` entries of a tailwind config, by colour name. */
function tailwindColors(file: string): Map<string, string> {
  const colors = new Map<string, string>();
  for (const m of read(file).matchAll(/'(tag-[\w-]+)'\s*:\s*'var\((--[\w-]+)\)'/g)) {
    colors.set(m[1]!, m[2]!);
  }
  return colors;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) {
    throw new Error(`"${hex}" is not a #rrggbb colour: the tag tokens must be plain hex so their contrast can be checked.`);
  }
  const lin = [0, 2, 4].map(i => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TAG_BG = classList('TAG_BG');
const TAG_TEXT = classList('TAG_TEXT');

describe('tag pill colours', () => {
  it('JobCard declares six background and six text classes', () => {
    expect(TAG_BG).toHaveLength(6);
    expect(TAG_TEXT).toHaveLength(6);
  });

  for (const target of TARGETS) {
    describe(target.name, () => {
      const colors = tailwindColors(target.tailwind);
      const css = read(target.css);
      const scopes = { light: scope(css, ':root'), dark: scope(css, target.dark) } as const;
      const tailwindSource = read(target.tailwind);

      TAG_BG.forEach((bgClass, i) => {
        const textClass = TAG_TEXT[i]!;
        const bgToken = colors.get(bgClass.replace(/^bg-/, ''));
        const textToken = colors.get(textClass.replace(/^text-/, ''));

        it(`${bgClass} and ${textClass} resolve to different tokens`, () => {
          expect(bgToken, `${bgClass} has no entry in ${target.tailwind}`).toBeDefined();
          expect(textToken, `${textClass} has no entry in ${target.tailwind}`).toBeDefined();
          expect(bgToken).not.toBe(textToken);
        });

        for (const theme of ['light', 'dark'] as const) {
          it(`${textClass} on ${bgClass} has a contrast of at least 4.5 in the ${theme} theme`, () => {
            const bg = scopes[theme].get(bgToken ?? '');
            const fg = scopes[theme].get(textToken ?? '');
            expect(bg, `${bgToken} is not defined in the ${theme} scope of ${target.css}`).toBeDefined();
            expect(fg, `${textToken} is not defined in the ${theme} scope of ${target.css}`).toBeDefined();
            expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
          });
        }

        it(`${bgClass} and ${textClass} are in the safelist`, () => {
          // The classes are chosen at run time from a hash, so Tailwind cannot see them in the source.
          const safelist = /safelist\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(tailwindSource);
          expect(safelist, `no safelist in ${target.tailwind}`).not.toBeNull();
          expect(safelist![1]).toContain(`'${bgClass}'`);
          expect(safelist![1]).toContain(`'${textClass}'`);
        });
      });
    });
  }
});
