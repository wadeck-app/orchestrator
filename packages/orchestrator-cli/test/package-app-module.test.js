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

/*
 * What the daemon registers is the PACKAGED module (`app-core-cli package`): app-core refuses a source
 * manifest. So the package must be built, with a version, before it is copied, in both jobs; and the
 * publish job must know the version it stamps before it packages.
 */
describe('the workflow packages the module before copying it', () => {
  const workflow = fs.readFileSync(path.join(packageRoot, '..', '..', '.github', 'workflows', 'publish-orchestrator.yml'), 'utf8');
  const publishAt = workflow.indexOf('\n    publish:');
  assert.ok(publishAt > 0, 'the workflow has no publish job');
  const jobs = { 'build-and-test': workflow.slice(0, publishAt), publish: workflow.slice(publishAt) };

  for (const [name, text] of Object.entries(jobs)) {
    it(`${name}: checks, then packages (stamping a version), then copies`, () => {
      const check = text.indexOf('npm run check --workspace=packages/app-module-orchestrator');
      const pack = text.indexOf('npm run package --workspace=packages/app-module-orchestrator');
      const copy = text.indexOf('copy-app-module.sh');
      assert.ok(check > 0, `${name} never runs the module's check`);
      assert.ok(pack > check, `${name} must package after checking`);
      assert.ok(copy > pack, `${name} must copy the module after packaging it`);
      const step = text.slice(text.lastIndexOf('- name:', pack), copy);
      assert.match(step, /BUNDLE_VERSION:\s*\S+/, `${name}: app-core-cli package fails without BUNDLE_VERSION`);
    });
  }

  it('publish: knows the version before it packages the module, so the manifest carries the published version', () => {
    const version = jobs.publish.indexOf('id: version');
    const pack = jobs.publish.indexOf('npm run package --workspace=packages/app-module-orchestrator');
    assert.ok(version > 0 && version < pack, 'the "Compute version" step must come before the module is packaged');
    assert.match(jobs.publish.slice(jobs.publish.lastIndexOf('- name:', pack), pack + 400), /BUNDLE_VERSION:\s*\$\{\{\s*steps\.version\.outputs\.version\s*\}\}/);
  });

  it('the copy script takes the packaged folder, not the sources', () => {
    const script = fs.readFileSync(path.join(packageRoot, 'ci', 'scripts', 'copy-app-module.sh'), 'utf8');
    assert.match(script, /app-module-orchestrator\/dist-module/);
    assert.doesNotMatch(script, /api-backend\/dist|\$module\/manifest\.json/);
  });
});
