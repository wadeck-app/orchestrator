import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The bar of JobProgress is dsl-ui's Progress, whose unfilled TRACK is `bg-muted-bg`: #f1f5f9 in the light
 * theme, which is nearly the colour of every light surface the bar sits on (the running banner, the amber
 * alert card, the page, the job cards). Only the blue fill showed, so 42 % looked like a short stub with no
 * idea of the full length. JobProgress now paints the track with `--color-progress-track`; these tests
 * resolve that token the way the browser will and require a contrast of 3:1 (WCAG 1.4.11, non-text) against
 * every background the bar is drawn on, in both themes, in both stylesheets (the module's and the SPA's).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../../dsl-lib-orch');
const appPkg = path.resolve(here, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const tailwindColors = createRequire(import.meta.url)('tailwindcss/colors') as Record<string, Record<string, string>>;

const MIN_CONTRAST = 3;
const TRACK_TOKEN = '--color-progress-track';

interface Target { name: string; css: string; tailwind: string; dark: string }
const TARGETS: Target[] = [
  { name: 'orch-app', css: path.join(appPkg, 'src/index.css'), tailwind: path.join(appPkg, 'tailwind.config.ts'), dark: '[data-theme="dark"]' },
];

/** The declarations of the first rule whose selector is exactly `selector`. */
function scope(css: string, selector: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[;}])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(withoutComments);
  if (m === null) {
    throw new Error(`No "${selector} { ... }" rule found: update src/progress-track.test.ts to the scopes the stylesheet uses.`);
  }
  const vars = new Map<string, string>();
  for (const d of m[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(d[1]!, d[2]!.trim());
  }
  return vars;
}

/** A `const NAME = '...'` string of a component, read from its source. */
function constString(file: string, name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*'([^']*)'`).exec(read(path.join(pkg, 'src/components', file)));
  if (m === null) {
    throw new Error(`${file} no longer declares "const ${name} = '...'": update src/progress-track.test.ts to where its classes live now.`);
  }
  return m[1]!;
}

/** The palette background (and its dark: variant) named in a class string, resolved against Tailwind's own palette. */
function paletteBg(classes: string, dark: boolean): string {
  const re = dark ? /(?:^|\s)dark:bg-(\w+)-(\d+)(?=\s|$)/ : /(?:^|\s)bg-(\w+)-(\d+)(?=\s|$)/;
  const m = re.exec(classes);
  if (m === null) {
    throw new Error(`No ${dark ? 'dark:' : ''}bg-<colour>-<shade> in "${classes}": update src/progress-track.test.ts.`);
  }
  const hex = tailwindColors[m[1]!]?.[m[2]!];
  if (hex === undefined) {
    throw new Error(`Tailwind has no colour ${m[1]}-${m[2]}.`);
  }
  return hex;
}

/** The hex of a `'--token': '#rrggbb'` entry of LogViewer's TERMINAL_TOKENS. */
function terminalToken(token: string): string {
  const m = new RegExp(`'${token}'\\s*:\\s*'(#[0-9a-fA-F]{6})'`).exec(read(path.join(pkg, 'src/components/LogViewer.tsx')));
  if (m === null) {
    throw new Error(`LogViewer.tsx TERMINAL_TOKENS has no hex for ${token}: update src/progress-track.test.ts.`);
  }
  return m[1]!;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) {
    throw new Error(`"${hex}" is not a #rrggbb colour: the progress tokens must be plain hex so their contrast can be checked.`);
  }
  const lin = [0, 2, 4].map(i => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const bannerCls = constString('RunningBannerDetail.tsx', 'BANNER_CLS');
const alertCls = constString('RunningAlertDetail.tsx', 'ALERT_CARD_CLS');

/** Every surface the bar is drawn on; `tokens` are the dsl-ui theme.css values of that theme. */
function surfaces(theme: 'light' | 'dark'): Array<{ place: string; bg: string }> {
  const dark = theme === 'dark';
  // dsl-ui's theme.css, which neither stylesheet of ours owns.
  const dsl = scope(read(path.resolve(here, '../../../node_modules/@wadeck-app/dsl-ui/src/theme.css')), dark ? ".dark,\n[data-theme='dark']" : ":root,\n.light,\n[data-theme='light']");
  const list = [
    { place: 'running banner (design A and the default)', bg: paletteBg(bannerCls, dark) },
    { place: 'amber alert card (design B)', bg: paletteBg(alertCls, dark) },
    { place: 'page background (design C inline row)', bg: dsl.get('--color-bg')! },
    { place: 'job card', bg: dsl.get('--color-surface')! },
    // The list view's Progress column: DataTable paints the table bg-surface and a hovered row bg-bg-secondary.
    { place: 'list view table row', bg: dsl.get('--color-surface')! },
    { place: 'list view table row, hovered', bg: dsl.get('--color-bg-secondary')! },
  ];
  if (dark) {
    // The log toolbar is a ThemeScope that is dark whatever the app theme is.
    list.push({ place: 'log page toolbar (terminal scope)', bg: terminalToken('--color-surface') });
  }
  return list;
}

describe('JobProgress track colour', () => {
  it('JobProgress paints the track with the progress-track token', () => {
    expect(read(path.join(pkg, 'src/components/JobProgress.tsx'))).toContain('bg-progress-track');
  });

  for (const target of TARGETS) {
    describe(target.name, () => {
      it('maps progress-track onto the custom property in the tailwind config', () => {
        expect(read(target.tailwind)).toMatch(/'progress-track'\s*:\s*'var\(--color-progress-track\)'/);
      });

      const css = read(target.css);
      for (const theme of ['light', 'dark'] as const) {
        const tokens = (): Map<string, string> => scope(css, theme === 'light' ? ':root' : target.dark);
        it(`defines ${TRACK_TOKEN} in the ${theme} scope`, () => {
          expect(tokens().get(TRACK_TOKEN), `${TRACK_TOKEN} is not defined in the ${theme} scope of ${target.css}`).toBeDefined();
        });
        for (const { place, bg } of surfaces(theme)) {
          it(`the track has a contrast of at least ${MIN_CONTRAST} on the ${place} in the ${theme} theme`, () => {
            const track = tokens().get(TRACK_TOKEN);
            expect(track, `${TRACK_TOKEN} is not defined in the ${theme} scope of ${target.css}`).toBeDefined();
            expect(contrast(track!, bg), `${track} on ${bg}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
          });
        }
      }
    });
  }

  it('the SPA stylesheet agrees with the module stylesheet on the token values', () => {
    const lib = read(path.join(pkg, 'src/styles/orchestrator.css'));
    const app = read(TARGETS[0]!.css);
    for (const [sel, appSel] of [[':root', ':root'], ['.dark, [data-theme="dark"]', TARGETS[0]!.dark]] as const) {
      expect(scope(app!, appSel).get(TRACK_TOKEN)).toBe(scope(lib!, sel).get(TRACK_TOKEN));
    }
  });
});
