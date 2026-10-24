import React from 'react';
import { Flame, AlertTriangle, FileText, Play } from 'lucide-react';
import { ButtonLink, Checkbox, Progress, Tooltip } from '@wadeck-app/dsl-ui';
import { isJobRunning, isRunActive, isRunCancelled, isRunFailed, isRunSkipped, latestRun, runEndReason, type Job, type ProgressEstimate, type RuntimeEntry, type TriggerRefused } from '../types.js';
import { windowStateAt } from '../active-window.js';
import { descriptionFirstLine } from '../job-description.js';
import { describeAgo } from '../relative-time.js';
import { describeResourceLimits, hasCustomLimits, limitsBadgeLabel } from '../resource-limits.js';
import { END_REASON_PILL, JobStatusPill } from './JobStatusPill.js';
import { JobProgress, PROGRESS_TRACK_CLS } from './JobProgress.js';
import { LateMarker } from './LateMarker.js';
import { NextFireCountdown } from './NextFireCountdown.js';
import { TriggerButton } from './TriggerButton.js';
import { EnableToggle } from './EnableToggle.js';
import { appPath } from '../runtime-config.js';

export interface JobCardProps {
  job: Job;
  runHistory: RuntimeEntry[];
  uptimePercent?: number | null;
  /** The job's `progress` from GET /api/jobs; shown only while the job is running. */
  progress?: ProgressEstimate | null;
  consecutiveFailures?: number;
  onTrigger: (id: string, opts?: { force: true }) => Promise<void | TriggerRefused>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onClick?: () => void;
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  /**
   * "Now", in epoch millis. Defaults to the real clock; the tests pass a fixed value.
   *
   * Threaded from here rather than read inside each child so one card renders against one instant --
   * the status pill and the countdown both depend on it, and reading the clock twice could show
   * "Pending" beside "Expires in 0s" across a tick boundary.
   */
  nowMs?: number;
}

// @formatter:off
export const TYPE_COLORS: Record<Job['type'], string> = {
  cron:    'bg-tag-cron-bg text-tag-cron',
  startup: 'bg-tag-startup-bg text-tag-startup',
  once:    'bg-tag-once-bg text-tag-once',
  // dsl-ui's muted tokens had 4.3:1 text (light) and a pill the colour of the card (dark): own tokens.
  manual:  'bg-tag-manual-bg text-tag-manual',
};

// Tag color palette (6 semantic tokens added to tailwind.config + index.css)
const TAG_BG  = ['bg-tag-1-bg','bg-tag-2-bg','bg-tag-3-bg','bg-tag-4-bg','bg-tag-5-bg','bg-tag-6-bg'] as const;
const TAG_TEXT = ['text-tag-1','text-tag-2','text-tag-3','text-tag-4','text-tag-5','text-tag-6'] as const;
// @formatter:on

/**
 * Uptime bar colour. Green while healthy, and only claims attention once it slips - a grid of
 * cards is scanned, not read.
 */
function uptimeVariant(percent: number): 'success' | 'default' | 'danger' {
  if (percent >= 99) {
    return 'success';
  }
  return percent >= 90 ? 'default' : 'danger';
}

/**
 * What one of the five run dots is showing.
 *
 * Pulled out of the JSX so each state can be asserted directly, rather than inferred from a class
 * name buried in a map callback.
 */
export type RunDotState = 'running' | 'cancelled' | 'skipped' | 'ok' | 'failed' | 'empty';

export function runDotState(entry: RuntimeEntry | undefined): RunDotState {
  if (!entry) {
    return 'empty';
  }
  if (isRunActive(entry)) {
    return 'running';
  }
  // Before the cancelled and exitCode branches: a skipped run's exit code is the child's own,
  // so the fallthrough would paint it red.
  if (isRunSkipped(entry)) {
    return 'skipped';
  }
  if (isRunCancelled(entry)) {
    return 'cancelled';
  }
  return entry.exitCode === 0 ? 'ok' : 'failed';
}

function tagColor(name: string): { bg: string; text: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const idx = h % 6;
  return { bg: TAG_BG[idx]!, text: TAG_TEXT[idx]! };
}

// @formatter:off
const CARD_CLS        = 'rounded-lg border border-border p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer bg-surface';
export const TYPE_BADGE_BASE = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0';
// @formatter:on

/**
 * Kept as a named re-export so the two call sites read the same as before.
 *
 * The body was the third private "how long ago" in dsl-lib-orch, each worded differently. This one said
 * "just now" under a minute, which told the reader less than the shared `describeAgo`'s "42s ago" --
 * on a last-run stamp the actual number is the thing being checked.
 */
export function relativeTime(isoDate: string): string {
  return describeAgo(isoDate, Date.now());
}

// Differs from JobStatusBadge only in the failed label, which counts failures across the
// history rather than naming one exit code.
//
// Takes the job as well as the history because "has not run" has two causes that need different words:
// a job whose active window opens later has not run because it is not due yet, which is the job working
// as configured. A real run outranks the window -- once something has happened, its outcome is the more
// useful fact, and the window shows up in the countdown beside this pill either way.
function jobListBadge(job: Job, runHistory: RuntimeEntry[], nowMs: number): React.ReactElement {
  if (runHistory.length === 0) {
    if (job.type === 'cron' && windowStateAt(job, nowMs) === 'pending') {
      return <JobStatusPill kind="pending" label="Pending" />;
    }
    return <JobStatusPill kind="never" label="Never run" />;
  }
  // Any open run, not the newest: with several instances the newest may have ended already.
  if (isJobRunning(runHistory)) {
    return <JobStatusPill kind="running" label="Running" />;
  }
  const last = latestRun(runHistory);
  // Ahead of the exitCode test so a skipped last run cannot be counted into "0x failed".
  if (isRunSkipped(last)) {
    return <JobStatusPill kind="skipped" label="Skipped" />;
  }
  // Ahead of the exitCode test: a timeout keeps the child's code and would be counted into "Nx failed".
  const endReason = runEndReason(last);
  if (endReason !== undefined) {
    const { kind, label } = END_REASON_PILL[endReason];
    return <JobStatusPill kind={kind} label={label} />;
  }
  // Only a legacy entry reaches here: a null exit code with no recorded reason.
  if (isRunCancelled(last)) {
    return <JobStatusPill kind="cancelled" label="Cancelled" />;
  }
  if (last!.exitCode === 0) {
    return <JobStatusPill kind="ok" label="OK" />;
  }
  const failCount = runHistory.filter(isRunFailed).length;
  return <JobStatusPill kind="failed" label={`${failCount}x failed`} />;
}

// Skipped runs are transparent: they neither extend the streak nor end it, so a scraper that
// no-ops every second hour still reads as healthy.
function successStreak(runHistory: RuntimeEntry[]): number {
  let streak = 0;
  for (const e of runHistory) {
    if (isRunSkipped(e)) {
      continue;
    }
    if (e.exitCode === 0) {
      streak++;
    }
    else {
      break;
    }
  }
  return streak;
}

// "since" is left out when the history does not reach back to the streak's start, rather than saying "since at an unrecorded time".
function failuresTooltip(count: number, since: string | null, now: number): string {
  return since === null ? `${count} failures in a row` : `${count} failures in a row, since ${describeAgo(since, now)}`;
}

/**
 * When the current run of failures began: the oldest of the `count` failed runs counted from the newest,
 * skipped runs being transparent (same walk as getConsecutiveFailures in JobCardGrid). The history is
 * newest-first, as the grid passes it. Null when the history holds fewer failures than `count`.
 */
function failureStreakSince(runHistory: RuntimeEntry[], count: number): string | null {
  let seen = 0;
  let since: string | null = null;
  for (const e of runHistory) {
    if (isRunSkipped(e)) {
      continue;
    }
    if (!isRunFailed(e) || seen === count) {
      break;
    }
    seen++;
    since = e.startedAt;
  }
  return seen === count ? since : null;
}

/**
 * @registryCategory composite
 * @registryTags job card
 */
export function JobCard({ job, runHistory, uptimePercent, progress, consecutiveFailures, onTrigger, onToggle, onClick, selected, onSelect, nowMs }: JobCardProps): React.ReactElement {
  const streak = successStreak(runHistory);
  const now = nowMs ?? Date.now();
  const descriptionLine = descriptionFirstLine(job.description);

  /*
   * A `once` job has exactly one firing, so the furniture of a recurring job is noise on its card: an
   * uptime percentage over n=1 is 0% or 100%, a success streak cannot reach the 2 it needs to show, and
   * four of the five run dots are permanently empty. All three are suppressed rather than left to
   * render a shape that invites the wrong reading.
   */
  const isOnce = job.type === 'once';
  // A spent job does have a log, and it is the only record of what happened. An unspent one has nothing
  // to show. For every other type the log is also where a failure to start shows up, so it always
  // stays -- the absence of runs is exactly when it is worth opening.
  const hasLogs = !isOnce || job.spent === true;

  return (
    <div className={CARD_CLS} onClick={onClick}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {onSelect != null && (
            // aria-label because the box has no visible label: it was previously an unlabelled
            // raw input, announced as nothing at all.
            <Checkbox
              checked={selected ?? false}
              onChange={() => {}}
              onClick={onSelect}
              aria-label={`Select ${job.label}`}
              className="shrink-0 cursor-pointer"
            />
          )}
          <span className="font-semibold text-content truncate">{job.label}</span>
          <span className={`${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type]}`}>{job.type}</span>
          {(job.tags ?? []).map(tag => {
            const { bg, text } = tagColor(tag);
            return (
              <span key={tag} className={`${TYPE_BADGE_BASE} ${bg} ${text}`}>{tag}</span>
            );
          })}
        </div>
        <EnableToggle job={job} onToggle={onToggle} />
      </div>

      {/*
        * First line only, one line, truncated by CSS. The whole text is the native title: dsl-ui's Tooltip
        * wraps its child in an inline-flex box that would defeat the truncation, and the title is
        * announced by screen readers and honours line breaks. Not rendered at all without a description,
        * so a card without one is not a pixel taller. The negative margin cancels the header's own.
        */}
      {descriptionLine !== undefined && (
        <p data-job-description className="text-xs text-muted truncate -mt-1 mb-2" title={job.description}>
          {descriptionLine}
        </p>
      )}

      {/* Only when the limits depart from the defaults, so a default card gains nothing. The values are the native title, like the description. */}
      {job.resourceLimits !== undefined && hasCustomLimits(job.resourceLimits) && (
        <p data-resource-limits className="text-xs text-muted mb-2" title={describeResourceLimits(job.resourceLimits).join('\n')}>
          {limitsBadgeLabel(job.resourceLimits)}
        </p>
      )}

      <div className="flex items-center gap-3 mb-1">
        {jobListBadge(job, runHistory, now)}
        <NextFireCountdown job={job} nowMs={now} />
      </div>
      {/* A running job's progress has a row of its own, the full card width: next to the uptime bar its text wrapped into
          three lines. Nothing is rendered for an idle job, so its card keeps its height. */}
      {progress != null && isJobRunning(runHistory) && (
        <div data-job-progress-row className="mb-2 min-w-0">
          <JobProgress progress={progress} fill />
        </div>
      )}
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-muted">
          {latestRun(runHistory)
            ? (() => {
                const last = latestRun(runHistory)!;
                const t = `Last run: ${relativeTime(last.startedAt)}`;
                if (last.finishedAt) {
                  const ms = new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime();
                  if (ms >= 0) {
                    const s = ms / 1000;
                    const dur = s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
                    return `${t} (${dur})`;
                  }
                }
                return t;
              })()
            : 'Last run: Never'}
        </p>
        {latestRun(runHistory)?.late === true && !isJobRunning(runHistory) && <LateMarker />}
        {/* Last 5 runs as coloured dots. The tooltip is what makes them readable: five 6px
            dots with no legend told the reader nothing about what they were looking at. */}
        {/* ml-auto has to sit on the outermost element to push the dots to the card edge.
            Tooltip inserts its own inline-flex wrapper and takes no className, so leaving
            ml-auto on the inner div left the dots crammed against the timestamp. */}
        {runHistory.length > 0 && !isOnce && (
          <span className="ml-auto">
          <Tooltip content="Last 5 runs, newest first">
          <div className="flex items-center gap-0.5">
            {Array.from({ length: 5 }, (_, i) => {
              const state = runDotState(runHistory[i]);
              // In progress reads as a shape, not just another colour: a grey circle among
              // coloured ones says "no result" far more than it says "running". A play triangle
              // says the thing is going. Blue rather than amber - it is activity, not a warning.
              if (state === 'running') {
                return (
                  <Play
                    key={i}
                    size={8}
                    data-run-state={state}
                    data-run-dot=""
                    aria-label="Running"
                    className="text-primary fill-current shrink-0"
                  />
                );
              }
              // violations-suppress-start: tailwind/no-raw-color-class pass/fail dot colors have no semantic-token equivalents in design system
              const CLS: Record<Exclude<RunDotState, 'running'>, string> = {
                cancelled: 'bg-orange-400',
                // Muted on purpose: a skipped run reports nothing, so it must not read as an
                // outcome. Darker than the empty slot so it is still visibly a recorded run.
                skipped:   'bg-muted',
                ok:        'bg-green-500',
                failed:    'bg-red-500',
                empty:     'bg-border',
              };
              // violations-suppress-end: tailwind/no-raw-color-class
              return (
                <span key={i} data-run-state={state} data-run-dot="" className={`w-1.5 h-1.5 rounded-full ${CLS[state]}`} />
              );
            })}
          </div>
          </Tooltip>
          </span>
        )}
      </div>

      {/* The whole row goes for a once job: with the streak, the uptime bar and the failure warning
          all suppressed it would render as an empty flex row that still eats its margin. */}
      {!isOnce && (
        <div className="flex items-center gap-3 mb-2">
          {streak >= 2 && (
            <div className="flex items-center gap-0.5">
              {/* violations-suppress: tailwind/no-raw-color-class streak flame icon uses orange which has no semantic token */}
              <Flame size={10} className="text-orange-400" />
              <span className="text-xs text-muted">{streak} streak</span>
            </div>
          )}
          {/* A bar reads faster than a number in a grid. This was bare text because Progress was
              w-full with its label on a separate line; it takes an inline layout now, and
              valueLabel keeps the decimal that the rounded percentage was hiding. */}
          {uptimePercent !== null && uptimePercent !== undefined && (
            <Tooltip content="Share of recent runs that succeeded">
              {/* The track would be nearly invisible on the card's light surface: same token as the progress bar. */}
              <span className={`inline-flex ${PROGRESS_TRACK_CLS}`}>
              <Progress
                value={uptimePercent}
                variant={uptimeVariant(uptimePercent)}
                valueLabel={`${uptimePercent.toFixed(1)}% uptime`}
                showValue
                layout="inline"
                size="sm"
              />
              </span>
            </Tooltip>
          )}
          {/* From 2, not from alertAfterFailures: at 1 the status pill already says Failed, at 2 it has become
              a pattern. alertAfterFailures stays what it was, the point where the daemon alerts. */}
          {consecutiveFailures !== undefined && consecutiveFailures >= 2 && (
            <Tooltip content={failuresTooltip(consecutiveFailures, failureStreakSince(runHistory, consecutiveFailures), now)}>
              <div className="flex items-center gap-0.5 text-warning">
                <AlertTriangle size={10} />
                <span className="text-xs">{consecutiveFailures} fails</span>
              </div>
            </Tooltip>
          )}
        </div>
      )}

      {/* Both controls at sm: a card footer is a compact context, and the two have to agree.
          They used to be a hand-rolled 26px link beside a 38px button. The span carries
          stopPropagation because the whole card is clickable. */}
      <div className="flex justify-end items-center gap-2">
        {hasLogs && (
          <span onClick={(e) => e.stopPropagation()}>
            <ButtonLink
              to={appPath(`/jobs/${job.id}/logs`)}
              label="Logs"
              icon={<FileText size={12} />}
              variant="secondary"
              size="sm"
            />
          </span>
        )}
        <TriggerButton jobId={job.id} onTrigger={onTrigger} size="sm" />
      </div>
    </div>
  );
}
