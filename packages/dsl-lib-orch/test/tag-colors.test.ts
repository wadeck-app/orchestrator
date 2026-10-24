import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The tags a user adds to a job are drawn as pills whose colours come from JobCard's TAG_BG / TAG_TEXT
 * classes. Both used to resolve to the SAME custom property, so every tag was a solid block with text of
 * exactly its own colour. These tests resolve the classes the way the browser will (class -> tailwind
 * colour -> custom property -> value in the light or the dark scope) and check the contrast, so a palette
 * edit cannot make the tags unreadable again.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8');

const jobCardSource = read(path.join(pkg, 'src/components/JobCard.tsx'));
const generatedStyle = path.resolve(pkg, '../app-module-orchestrator/src/dsl-components/style.css');

interface Target { name: string; css: string; tailwind: string; dark: string }
const TARGETS: Target[] = [
  { name: 'dsl-lib-orch', css: path.join(pkg, 'src/styles/orchestrator.css'), tailwind: path.join(pkg, 'tailwind.config.ts'), dark: '.dark, [data-theme="dark"]' },
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

  describe('the stylesheet generated for app-core', () => {
    const style = read(generatedStyle);
    const ruleVar = (cls: string): string => {
      const m = new RegExp(`\\.${cls}\\s*\\{[^}]*?(?:background-color|color):\\s*(?:rgb\\()?var\\((--[\\w-]+)\\)`).exec(style);
      if (m === null) {
        throw new Error(`.${cls} is not in ${generatedStyle}: run "npm run css --workspace=packages/dsl-lib-orch".`);
      }
      return m[1]!;
    };

    TAG_BG.forEach((bgClass, i) => {
      it(`${bgClass} and ${TAG_TEXT[i]} use different custom properties`, () => {
        expect(ruleVar(bgClass)).not.toBe(ruleVar(TAG_TEXT[i]!));
      });
    });
  });
});

/*
 * The job TYPE pill (cron / startup / once / manual) is not a user tag: its classes come from JobCard's
 * TYPE_COLORS. In the dark theme the `once` pill was #1f2937 on a #1e293b card (invisible) and `manual`
 * (dsl-ui's muted tokens) had 4.0:1 text. Each type must have readable text (4.5:1) and a pill that stands
 * out from every surface it is drawn on (1.3:1), in both themes.
 */
describe('job type pill colours', () => {
  const MIN_TEXT = 4.5;
  const MIN_PILL = 1.3;
  const TYPES = ['cron', 'startup', 'once', 'manual'] as const;
  const palette = createRequire(import.meta.url)('tailwindcss/colors') as Record<string, Record<string, string>>;

  const typeColors = ((): Record<string, string> => {
    const m = /export const TYPE_COLORS[^=]*=\s*\{([^}]*)\}/.exec(jobCardSource);
    if (m === null) {
      throw new Error('JobCard.tsx no longer exports "TYPE_COLORS = {...}": update the type pill test to where the classes live now.');
    }
    return Object.fromEntries([...m[1]!.matchAll(/(\w+):\s*'([^']+)'/g)].map(x => [x[1]!, x[2]!]));
  })();

  const constString = (file: string, name: string): string => {
    const m = new RegExp(`const ${name}\\s*=\\s*'([^']*)'`).exec(read(path.join(pkg, 'src/components', file)));
    if (m === null) {
      throw new Error(`${file} no longer declares "const ${name} = '...'": update the type pill test.`);
    }
    return m[1]!;
  };
  const paletteBg = (classes: string, dark: boolean): string => {
    const m = (dark ? /(?:^|\s)dark:bg-(\w+)-(\d+)(?=\s|$)/ : /(?:^|\s)bg-(\w+)-(\d+)(?=\s|$)/).exec(classes);
    const hex = m === null ? undefined : palette[m[1]!]?.[m[2]!];
    if (hex === undefined) {
      throw new Error(`No ${dark ? 'dark:' : ''}bg-<colour>-<shade> in "${classes}": update the type pill test.`);
    }
    return hex;
  };

  /** dsl-ui's theme.css, which neither stylesheet of ours owns. */
  const dslTheme = (dark: boolean): Map<string, string> => scope(
    read(path.resolve(pkg, '../../node_modules/@wadeck-app/dsl-ui/src/theme.css')),
    dark ? ".dark,\n[data-theme='dark']" : ":root,\n.light,\n[data-theme='light']",
  );

  /** Every surface a type pill is drawn on: job card, table rows and job page (bg), running banner, alert card. */
  const surfaces = (dark: boolean): Array<{ place: string; bg: string }> => {
    const dsl = dslTheme(dark);
    return [
      { place: 'job card', bg: dsl.get('--color-surface')! },
      { place: 'page background', bg: dsl.get('--color-bg')! },
      { place: 'running banner', bg: paletteBg(constString('RunningBannerDetail.tsx', 'BANNER_CLS'), dark) },
      { place: 'amber alert card', bg: paletteBg(constString('RunningAlertDetail.tsx', 'ALERT_CARD_CLS'), dark) },
    ];
  };

  it('TYPE_COLORS has the four job types', () => {
    expect(Object.keys(typeColors).sort()).toEqual([...TYPES].sort());
  });

  for (const target of TARGETS) {
    describe(`${target.name} type pills`, () => {
      const colors = tailwindColors(target.tailwind);
      const css = read(target.css);
      for (const theme of ['light', 'dark'] as const) {
        const dark = theme === 'dark';
        const own = scope(css, dark ? target.dark : ':root');
        // A colour name is one of ours (tag-*) or one of dsl-ui's generic tokens (muted, muted-bg...).
        const resolve = (name: string): string => {
          const token = colors.get(name) ?? `--color-${name}`;
          const value = own.get(token) ?? dslTheme(dark).get(token);
          if (value === undefined) {
            throw new Error(`${token} (class colour "${name}") is defined neither in ${target.css} nor in dsl-ui's theme.css, ${theme} scope.`);
          }
          return value;
        };
        for (const type of TYPES) {
          const classes = typeColors[type] ?? '';
          const bgName = /(?:^|\s)bg-(\S+)/.exec(classes)?.[1] ?? '';
          const textName = /(?:^|\s)text-(\S+)/.exec(classes)?.[1] ?? '';
          it(`${type}: text has a contrast of at least ${MIN_TEXT} on its pill in the ${theme} theme`, () => {
            expect(bgName, `no bg-* class in TYPE_COLORS.${type}`).not.toBe('');
            expect(textName, `no text-* class in TYPE_COLORS.${type}`).not.toBe('');
            expect(contrast(resolve(textName), resolve(bgName))).toBeGreaterThanOrEqual(MIN_TEXT);
          });
          for (const { place, bg } of surfaces(dark)) {
            it(`${type}: the pill stands out by at least ${MIN_PILL} from the ${place} in the ${theme} theme`, () => {
              const pill = resolve(bgName);
              expect(contrast(pill, bg), `${pill} on ${bg}`).toBeGreaterThanOrEqual(MIN_PILL);
            });
          }
        }
      }
    });
  }
});
