'use strict';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The daemon registers the dashboard module from app-module/ inside the installed package. If the
 * folder is not listed in `files`, npm drops it from the tarball and every install silently has no
 * module: the daemon logs "no app-module found" and the pages never show up in app-core.
 */
const packageRoot = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

describe('the published package', () => {
  it('ships the app-core module folder the daemon registers', () => {
    assert.ok(pkg.files.includes('app-module/'), `"app-module/" is missing from package.json "files": ${JSON.stringify(pkg.files)}`);
  });

  it('has a script that assembles it, which both CI jobs run', () => {
    const script = path.join(packageRoot, 'ci', 'scripts', 'copy-app-module.sh');
    assert.ok(fs.existsSync(script), `${script} is missing`);

    const workflow = fs.readFileSync(path.join(packageRoot, '..', '..', '.github', 'workflows', 'publish-orchestrator.yml'), 'utf8');
    const runs = workflow.match(/copy-app-module\.sh/g) ?? [];
    assert.equal(runs.length, 2, 'build-and-test and publish must both assemble app-module/, or the tested package differs from the published one');
  });
});
