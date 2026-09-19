// Print CI run and per-step timings from the public GitHub API.
// Usage:
//   node scripts/ci-timings.mjs runs [branch] [count]   -- list recent runs
//   node scripts/ci-timings.mjs steps <runId>           -- per-job, per-step durations
const REPO = 'wadeck-app/orchestrator';
const API = `https://api.github.com/repos/${REPO}`;

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const secs = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null);

async function listRuns(branch = 'main', count = '10') {
  const d = await get(`${API}/actions/runs?branch=${branch}&per_page=${count}`);
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

async function steps(runId) {
  const d = await get(`${API}/actions/runs/${runId}/jobs?per_page=100`);
  for (const job of d.jobs) {
    console.log(`\n== ${job.name} [${job.conclusion ?? job.status}] ${secs(job.started_at, job.completed_at) ?? '?'}s`);
    for (const s of job.steps ?? []) {
      const t = secs(s.started_at, s.completed_at);
      console.log(`   ${String(t ?? '?').padStart(4)}s  ${s.conclusion.padEnd(8)} ${s.name}`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'runs') await listRuns(...args);
else if (cmd === 'steps') await steps(args[0]);
else {
  console.error('usage: ci-timings.mjs runs [branch] [count] | steps <runId>');
  process.exit(2);
}
