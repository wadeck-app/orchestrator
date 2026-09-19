// Print CI run and per-step timings from the GitHub API.
//
// Exists because ordering CI work needs per-step numbers, and the alternative was pasting whole
// workflow-run JSON blobs around. Reads only.
//
// Usage:
//   node scripts/ci-timings.mjs runs [branch] [count]   -- list recent runs
//   node scripts/ci-timings.mjs steps <runId>           -- per-job, per-step durations
//
// Set GITHUB_TOKEN (or GH_TOKEN) to raise the 60 requests/hour unauthenticated limit, and to read a
// private repo at all.
import { execFileSync } from 'node:child_process';

const API_MAX_PER_PAGE = 100;

/**
 * The repo to query, derived from git rather than hardcoded.
 *
 * A hardcoded slug is the worst failure mode available here: on a fork it reports the upstream's CI
 * as if it were yours, plausibly and silently.
 */
function repoSlug() {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch (err) {
    fail(`could not read the origin remote, so there is no repo to query: ${err.message}`);
  }
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    fail(`could not parse an owner/repo out of the origin remote: ${url}`);
  }
  return `${match[1]}/${match[2]}`;
}

function fail(message) {
  console.error(`ci-timings: ${message}`);
  process.exit(2);
}

function usage(message) {
  if (message) console.error(`ci-timings: ${message}`);
  console.error('usage: ci-timings.mjs runs [branch] [count]');
  console.error('       ci-timings.mjs steps <runId>');
  process.exit(2);
}

async function get(url) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.ok) return res.json();

  // Named causes rather than a bare status. Both of these read as "bad run id" otherwise, and both
  // have a specific fix the caller cannot guess from a 403 or a 404.
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      fail(`GitHub API rate limit exhausted${token ? '' : ' (unauthenticated: 60/hour)'}.`
        + `${token ? '' : ' Set GITHUB_TOKEN to raise it.'}`);
    }
  }
  if (res.status === 404 && !token) {
    fail(`404 for ${url}. If this repo is private, set GITHUB_TOKEN -- an unauthorised read of a`
      + ` private repo is reported as 404, not 401.`);
  }
  fail(`GET ${url} -> ${res.status} ${res.statusText}`);
}

const secs = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null);

async function listRuns(api, branch = 'main', countArg = '10') {
  const count = Number(countArg);
  if (!Number.isInteger(count) || count < 1) {
    usage(`count must be a positive integer, got ${JSON.stringify(countArg)}`);
  }
  if (count > API_MAX_PER_PAGE) {
    // The API caps per_page at 100 and says nothing about it, so asking for 500 silently gives 100.
    fail(`count must be ${API_MAX_PER_PAGE} or fewer (the API caps a page there and does not say so)`);
  }

  const d = await get(`${api}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${count}`);
  if (d.workflow_runs.length === 0) {
    // Silence here reads as "CI is broken". It usually means the branch name is wrong.
    console.error(`ci-timings: no workflow runs found on branch "${branch}".`
      + ` Check the branch name -- an unknown branch returns an empty list, not an error.`);
    return;
  }
  for (const r of d.workflow_runs) {
    console.log(
      [
        r.id,
        `#${r.run_number}`,
        r.head_sha.slice(0, 7),
        r.status,
        r.conclusion ?? '-',
        `${secs(r.run_started_at, r.updated_at) ?? '?'}s`,
        r.display_title.slice(0, 60),
      ].join('  '),
    );
  }
}

async function steps(api, runId) {
  if (!runId) usage('steps needs a run id');
  if (!/^\d+$/.test(runId)) usage(`a run id is all digits, got ${JSON.stringify(runId)}`);

  const d = await get(`${api}/actions/runs/${runId}/jobs?per_page=${API_MAX_PER_PAGE}`);
  if (d.total_count > d.jobs.length) {
    // Reported rather than quietly showing a subset. Reachable as the matrix grows.
    console.error(`ci-timings: showing ${d.jobs.length} of ${d.total_count} jobs`
      + ` -- this script does not paginate.`);
  }
  for (const job of d.jobs) {
    console.log(`\n== ${job.name} [${job.conclusion ?? job.status}] ${secs(job.started_at, job.completed_at) ?? '?'}s`);
    for (const s of job.steps ?? []) {
      const t = secs(s.started_at, s.completed_at);
      // conclusion is null while a step is queued or running, and watching an in-flight run is a
      // primary use of this script -- unguarded, .padEnd threw and said nothing about why.
      const outcome = s.conclusion ?? s.status ?? '-';
      console.log(`   ${String(t ?? '?').padStart(4)}s  ${outcome.padEnd(8)} ${s.name}`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
const api = `https://api.github.com/repos/${repoSlug()}`;
if (cmd === 'runs') {
  if (args.length > 2) usage(`runs takes at most a branch and a count, got ${args.length} arguments`);
  await listRuns(api, ...args);
} else if (cmd === 'steps') {
  if (args.length > 1) usage(`steps takes one run id, got ${args.length} arguments`);
  await steps(api, args[0]);
} else {
  usage(cmd ? `unknown command ${JSON.stringify(cmd)}` : null);
}
