// AUTO-GENERATION script - run: npm run gen-icons -w packages/orchestrator
// Generates src/tray-icons.ts from the Lucide list-clock SVG at 64x64.
// Supports a configurable tray color (default white) matching wdrive's approach.

import sharp from 'sharp';
import fs   from 'node:fs';
import path from 'node:path';

const OUT = path.join(__dirname, '..', 'src', 'tray-icons.ts');

// Supported colors - same as wdrive
const COLORS = ['#FFFFFF', '#93C5FD', '#6EE7B7', '#FCA5A5', '#FCD34D', '#A5B4FC', '#F9A8D4', '#CBD5E1', '#FED7AA'];
const DEFAULT_COLOR = '#FFFFFF';

// Lucide list-clock (24x24 viewport, stroke-width 2, round caps/joins)
function listClockSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 12H3"/>
  <path d="M16 6H3"/>
  <path d="M12 18H3"/>
  <circle cx="18" cy="18" r="4"/>
  <path d="m18 16.5.5 1.5h1.5"/>
</svg>`;
}

// Error state: clock icon with a solid red badge (bottom-right, r=6 filled)
// Larger badge so it is clearly visible at small systray sizes.
function listClockErrorSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 12H3"/>
  <path d="M16 6H3"/>
  <path d="M10 18H3"/>
  <circle cx="18" cy="18" r="6" fill="#EF4444" stroke="#EF4444"/>
  <path d="M18 15v3.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="18" cy="20.5" r="0.75" fill="white" stroke="none"/>
</svg>`;
}

// Running state: clock icon with a solid blue badge (bottom-right hourglass shape)
function listClockRunningSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 12H3"/>
  <path d="M16 6H3"/>
  <path d="M10 18H3"/>
  <circle cx="18" cy="18" r="6" fill="#3B82F6" stroke="#3B82F6"/>
  <path d="M15.5 14.5h5l-2.5 3 2.5 3h-5l2.5-3-2.5-3z" fill="white" stroke="none"/>
</svg>`;
}

async function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).resize(64, 64).png().toBuffer();
}

async function main(): Promise<void> {
  const lines: string[] = [
    `// AUTO-GENERATED - do not edit manually.`,
    `// Re-run: npm run gen-icons -w packages/orchestrator`,
    `// Lucide list-clock, 64x64 PNG base64 - ${COLORS.length} colors x 3 states`,
    ``,
    `export type IconState = 'idle' | 'error' | 'running';`,
    `export type IconSet = Record<IconState, string>;`,
    `export const DEFAULT_TRAY_COLOR = '${DEFAULT_COLOR}';`,
    `export const SUPPORTED_TRAY_COLORS = ${JSON.stringify(COLORS)} as const;`,
    ``,
    `export const ICONS_BY_COLOR: Record<string, IconSet> = {`,
  ];

  for (const color of COLORS) {
    const idlePng    = await svgToPng(listClockSvg(color));
    const errorPng   = await svgToPng(listClockErrorSvg(color));
    const runningPng = await svgToPng(listClockRunningSvg(color));
    lines.push(`  // ${color}`);
    lines.push(`  ${JSON.stringify(color)}: {`);
    lines.push(`    idle:    '${idlePng.toString('base64')}',`);
    lines.push(`    error:   '${errorPng.toString('base64')}',`);
    lines.push(`    running: '${runningPng.toString('base64')}',`);
    lines.push(`  },`);
  }

  lines.push(`};`);
  lines.push(``);
  lines.push(`export function getIcons(trayColor?: string): IconSet {`);
  lines.push(`  const c = (trayColor ?? DEFAULT_TRAY_COLOR).toUpperCase();`);
  lines.push(`  const match = SUPPORTED_TRAY_COLORS.find(s => s.toUpperCase() === c);`);
  lines.push(`  return ICONS_BY_COLOR[match ?? DEFAULT_TRAY_COLOR]!;`);
  lines.push(`}`);

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  // violations-suppress: shared/no-emoji local/no-unicode-symbol script output - intentional terminal indicator
  console.log(`✓ wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
