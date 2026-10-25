import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { listLibTypes } from '../src/libTypes.js';
import { LIB_ENTRIES, MODULE_VIEWS_DIR } from '../src/paths.js';

/*
 * src/dsl-views/ is the source of the module's pages: edited there, no longer derived from anything. These
 * checks are what a derive step used to guarantee for free: every page is mounted under the module's
 * prefixes and names only types the library ships.
 */
const views = fs.readdirSync(MODULE_VIEWS_DIR).filter(name => name.endsWith('.yaml'));
const read = (name: string): string => fs.readFileSync(path.join(MODULE_VIEWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');

describe('src/dsl-views', () => {
  it('holds the ten views the module serves', () => {
    expect([...views].sort()).toEqual([
      'audit.yaml', 'failure-overlay.yaml', 'job-edit.yaml', 'job-logs.yaml', 'job-new.yaml', 'job.yaml',
      'jobs.yaml', 'navbar-stats.yaml', 'schedule.yaml', 'status-widget.yaml',
    ]);
  });

  it('names only types the dsl-lib really ships, so no page asks the shell for a component that is not there', () => {
    const shipped = new Set(listLibTypes(fs.readFileSync(LIB_ENTRIES, 'utf8')));
    for (const name of views) {
      for (const match of read(name).matchAll(/\$type:\s*orchestrator:(\w+)/g)) {
        expect(shipped.has(match[1]!), `${name} uses $type orchestrator:${match[1]}, which the dsl-lib does not export`).toBe(true);
      }
    }
  });

  it('prefixes SearchBar: the shell\'s own copy publishes no event, so the page would never filter', () => {
    expect(read('jobs.yaml')).toContain('$type: orchestrator:SearchBar');
    expect(read('jobs.yaml')).not.toMatch(/\$type:\s*SearchBar\b/);
  });

  it('serves every page from the module, never from the root API, and declares no $route of its own', () => {
    for (const name of views) {
      expect(read(name), name).not.toMatch(/url:\s*(GET|POST|PUT|DELETE)\s+\/api\/(?!modules\/orchestrator\/)/);
      expect(read(name), name).not.toMatch(/^\$route:/m);
    }
  });
});

describe('the module log page', () => {
  it('shows the progress and estimated end of the running job, polled so it keeps moving', () => {
    const page = read('job-logs.yaml');
    expect(page).toMatch(/\$type:\s*orchestrator:LogViewer[\s\S]*progress:\s*\$sources\.jobData\.progress/);
    expect(page).toMatch(/jobData:[\s\S]*poll:\s*\d+s/);
  });
});

describe('the module edit page', () => {
  it('gives the Cancel navigation the id it puts in its address', () => {
    // `to: .../jobs/{id}` has nothing to fill {id} with unless the brain is given it: Cancel went nowhere, and it only
    // seemed to work because the button also submitted the form, whose save navigated to the list.
    const page = read('job-edit.yaml');
    const cancel = /navigateCancel:\n([\s\S]*?)\n\S/.exec(page + '\nend')?.[1] ?? '';
    expect(cancel).toContain('/modules/orchestrator/jobs/{id}');
    expect(cancel).toMatch(/\n?\s*id:\s*\$route\.id/);
  });
});

/*
 * app-core's dashboard is a grid of 100px cells and every widget should use all the room of its tile. The three
 * figures share one row (each takes a third of it) and the daemon is one line, so the tile is as tall as its
 * content and no taller.
 */
describe('the dashboard widget (status-widget.yaml)', () => {
  const page = read('status-widget.yaml');
  const items = (block: string): string[] => block.split(/^\s*- (?=\$type:)/m).slice(1);

  it('puts the three figures in one HorizontalStack, each taking an equal share of the row', () => {
    const row = /^ {2}- \$type: HorizontalStack\n([\s\S]*?)(?=^ {2}- \$type: (?!StatTile)|(?![\s\S]))/m.exec(page)?.[1] ?? '';
    expect(row, 'no HorizontalStack row under the root stack').not.toBe('');
    expect(row).toMatch(/itemSizes:\s*\[\s*flex\s*,\s*flex\s*,\s*flex\s*\]/);
    const tiles = items(row.slice(row.indexOf('items:')));
    expect(tiles.map(t => /label:\s*(.+)/.exec(t)?.[1]?.trim())).toEqual(['Jobs', 'Running', 'Recent failures']);
    expect(tiles.every(t => t.startsWith('$type: StatTile'))).toBe(true);
  });

  it('has no StatTile outside that row, so none is stacked on its own', () => {
    const before = page.slice(0, page.indexOf('HorizontalStack'));
    const after = page.slice(page.indexOf('$type: orchestrator:DaemonStatus'));
    expect(before).not.toContain('StatTile');
    expect(after).not.toContain('StatTile');
  });

  it('shows the daemon as the compact line, whose details are on the Jobs page', () => {
    expect(page).toMatch(/\$type:\s*orchestrator:DaemonStatus\n\s+compact:\s*true/);
  });
});
