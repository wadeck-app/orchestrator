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
