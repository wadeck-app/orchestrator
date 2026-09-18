import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, ArrowDown, Pause } from 'lucide-react';
import { ButtonAction, ChipButton, SearchBar, ThemeScope } from '@wadeck-app/dsl-ui';
import { getErrorMessage, isRunActive, latestRun, type RuntimeEntry } from '../types.js';
import { LOG_FILL_HEIGHT_CLASS } from './log-fill-height.js';

// violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname,react/no-raw-button terminal/console pane must stay dark regardless of app theme; semantic surface tokens would invert on light mode; Button component doesn't support icon+label in compact terminal header style
// @formatter:off
// How far from the bottom still counts as "at the tail". Sub-pixel scroll heights and the browser
// clamping scrollTop mean an exact comparison flickers between following and paused.
const BOTTOM_SLACK_PX = 20;
/*
 * The terminal palette, handed to dsl-ui's ThemeScope.
 *
 * This used to be a string of Tailwind arbitrary properties plus a separate `[color-scheme:dark]`,
 * maintained here. ThemeScope generalises exactly that: it carries the palette AND the UA
 * colour-scheme together, so the two cannot drift - and it is the same component any other app
 * uses for a console, a code viewer or a print preview.
 *
 * Declared at module scope, not inline in the render, because changing a custom property
 * invalidates computed style for the whole subtree. A frozen object can never do that.
 */
const TERMINAL_TOKENS: Record<string, string> = {
  '--color-surface': '#374151',
  '--color-bg': '#111827',
  '--color-content': '#e5e7eb',
  '--color-muted': '#9ca3af',
  '--color-muted-bg': '#4b5563',
  '--color-border': '#4b5563',
  '--color-bg-secondary': '#4b5563',
  '--color-primary': '#60a5fa',
  '--color-primary-solid': '#2563eb',
  '--color-primary-solid-hover': '#1d4ed8',
};
// @formatter:on
// min-h-0 lets the pane shrink inside a flex parent; without it a flex child is min-height:auto,
// never overflows, and follow-tail silently does nothing.
const CONTAINER_BASE_CLS = 'flex flex-col min-h-0';
// Fallback for hosts that give the widget no height: h-full would resolve to
// auto, so the pane would never overflow and follow-tail would silently do
// nothing. 75vh keeps it scrollable without the host's help.
const CONTAINER_CAPPED_CLS = `${CONTAINER_BASE_CLS} h-full max-h-[75vh]`;
// Claims the viewport minus the log page's chrome, term by term - see log-fill-height.ts. It was
// a single hand-written 6.75rem, which covered the chrome above the pane and forgot the container's
// padding below it, so the page grew a scrollbar of its own.
// DSL sections stack in a plain space-y container rather than a flex column, so flex-1 would
// collapse to nothing here and the viewport has to be measured against instead.
const CONTAINER_FILL_CLS = `${CONTAINER_BASE_CLS} ${LOG_FILL_HEIGHT_CLASS}`;
// Semantic tokens, resolved to the terminal palette by TERMINAL_TOKENS above. These were
// bg-gray-800/700/900 literals, which is what locked every design-system component out.
const LOG_HEADER_CLS     = 'flex items-center gap-2 px-3 py-1.5 bg-surface text-muted text-xs rounded-t';
const LOG_BODY_CLS       = 'flex-1 overflow-auto bg-bg text-green-400 font-mono text-sm p-4 rounded-b';
// The console green stays literal: it is the terminal's own ink, not a themed surface.
const RUN_SELECT_CLS     = 'bg-muted-bg border border-border text-content rounded px-2 py-0.5 text-xs focus:outline-none mr-2';
// @formatter:on
// violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname

// Matches file:/// URLs, http(s) URLs, and Windows absolute paths with known extensions.
const URL_RE = /(file:\/\/\/[^\s\r\n]+|https?:\/\/[^\s\r\n]+|[A-Za-z]:[\\\/][^\s\r\n]+\.(?:html?|json|csv|txt|log))/gi;

function toFileUrl(raw: string): string {
  if (raw.startsWith('file:///') || raw.startsWith('http')) return raw;
  // Convert Windows path: C:\foo\bar.html -> file:///C:/foo/bar.html
  return 'file:///' + raw.replace(/\\/g, '/');
}

function isLocalFile(raw: string): boolean {
  return raw.startsWith('file:///') || /^[A-Za-z]:[\\\/]/.test(raw);
}

// Chrome blocks file:// navigation from http:// pages.
// Route local file opens through the dashboard server's /api/open endpoint instead.
function openHref(raw: string, apiBase: string): string {
  if (!isLocalFile(raw)) return raw; // http(s) URLs open directly
  const fileUrl = toFileUrl(raw);
  return `${apiBase}/api/open?path=${encodeURIComponent(fileUrl)}`;
}

function linkify(line: string, highlight: string | undefined, apiBase: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;

  const pushText = (text: string): void => {
    if (!highlight || !text) {
      parts.push(text);
      return;
    }
    const re = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const sub = text.split(re);
    sub.forEach((s, i) => {
      if (re.test(s)) {
        // violations-suppress: tailwind/no-raw-color-class search highlight uses yellow which has no semantic token
        parts.push(<mark key={`h${i}`} className="bg-yellow-400 text-gray-900 rounded-sm">{s}</mark>);
      } else {
        parts.push(s);
      }
    });
  };

  while ((m = URL_RE.exec(line)) !== null) {
    if (m.index > last) pushText(line.slice(last, m.index));
    const href = openHref(m[0], apiBase);
    parts.push(
      // violations-suppress: tailwind/no-raw-color-class link inside dark terminal - no semantic token for terminal-link color
      <a key={m.index} href={href} target={isLocalFile(m[0]) ? '_self' : '_blank'} rel="noopener noreferrer"
        className="underline opacity-80 hover:opacity-100">{m[0]}</a>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) pushText(line.slice(last));
  return parts.length > 0 ? parts : line;
}

interface RunEntry { name: string; file: string; sizeBytes: number; }

function fmtRunName(name: string, index: number, total: number): string {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4]} #${total - index}`;
  return name; // legacy daily format: already yyyy-mm-dd
}

export interface LogViewerProps {
  jobId: string;
  apiBase?: string;
  /** Grow to the host's height instead of stopping at the 75vh fallback cap. */
  fill?: boolean;
}

/**
 * @registryCategory composite
 * @registryTags log viewer streaming sse
 */
export function LogViewer({ jobId, apiBase = '', fill = false }: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState('');
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedRun, setSelectedRun] = useState<string>(searchParams.get('run') ?? '');
  const [isJobRunning, setIsJobRunning] = useState(false);
  // Single source of truth for following the tail. It used to be three: this flag, a `paused`
  // state derived from the scroll position, and a `userScrolledUp` ref that silently vetoed the
  // flag. Scrolling up set the veto and the label without touching the flag, so the button still
  // claimed auto-scroll was on; the first click then merely turned the flag off and a second was
  // needed to actually resume. That is the "I have to click twice" -- the button and the behaviour
  // were reading different variables.
  const [autoScroll, setAutoScroll] = useState(true);
  const [killing, setKilling] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);

  const handleSelectRun = (name: string): void => {
    setSelectedRun(name);
    setSearchParams(name ? { run: name } : {}, { replace: true });
  };

  // Fetch available run list
  useEffect(() => {
    fetch(`${apiBase}/api/logs/${jobId}/runs`)
      .then(r => r.ok ? r.json() as Promise<RunEntry[]> : [])
      .then(data => {
        setRuns(data);
        // Only default to latest if no ?run= in URL
        if (data.length > 0 && !searchParams.get('run')) handleSelectRun(data[0]!.name);
      })
      .catch(() => {});
  }, [jobId, apiBase]);

  // Check if job is currently running
  useEffect(() => {
    const checkJobStatus = (): void => {
      fetch(`${apiBase}/api/jobs/${jobId}`)
        .then(r => r.ok ? r.json() as Promise<{ job: unknown; runHistory: RuntimeEntry[] }> : null)
        .then(data => {
          if (data?.runHistory) setIsJobRunning(isRunActive(latestRun(data.runHistory)));
        })
        .catch(() => {});
    };

    checkJobStatus();
    const interval = setInterval(checkJobStatus, 2000);
    return () => { clearInterval(interval); };
  }, [jobId, apiBase]);

  useEffect(() => {
    setLines([]);
    setConnected(false);
    // A new run starts at the tail again.
    setAutoScroll(true);

    const url = selectedRun
      ? `${apiBase}/api/logs/${jobId}/stream?run=${encodeURIComponent(selectedRun)}`
      : `${apiBase}/api/logs/${jobId}/stream`;
    const es = new EventSource(url);
    es.onopen = () => { setConnected(true); };
    es.onmessage = (ev) => {
      setConnected(true);
      if (ev.data) setLines((prev) => [...prev, ev.data as string]);
    };
    es.onerror = () => { setConnected(false); };
    return () => { es.close(); };
  }, [jobId, apiBase, selectedRun]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    // Scrolling away from the tail IS switching following off, and scrolling back to it switches
    // following on. Expressing it as the one flag is what keeps the button honest: it can no
    // longer show a state that the scroll handler has quietly overridden.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    setAutoScroll(atBottom);
  };

  const handleKillJob = async (): Promise<void> => {
    if (!confirm(`Kill running job "${jobId}"?`)) return;
    setKilling(true);
    try {
      const res = await fetch(`${apiBase}/api/jobs/${jobId}/kill`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        alert(err.error ?? `Failed to kill job (HTTP ${res.status})`);
        return;
      }
      // Hide the button right away; the status poll re-shows it if a new run starts.
      setIsJobRunning(false);
    } catch (err) {
      alert(`Failed to kill job: ${getErrorMessage(err)}`);
    } finally {
      setKilling(false);
    }
  };

  const handleAutoScrollToggle = (): void => {
    // The next value is computed once and used for both the state and the scroll. Branching on
    // `autoScroll` after calling the setter read the value from before the click, so resuming
    // skipped the jump to the tail and only the second click ever scrolled.
    const next = !autoScroll;
    setAutoScroll(next);
    if (next) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  };

  const filtered = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;
  const matchCount = search ? filtered.length : null;

  return (
    // theme="dark" for the UA chrome - the scrollbar and the run select are browser-painted, and in
    // a light app they would come out white over a near-black pane. surface="none" because the
    // palette below supplies the background itself.
    <ThemeScope
      theme="dark"
      surface="none"
      tokens={TERMINAL_TOKENS}
      className={fill ? CONTAINER_FILL_CLS : CONTAINER_CAPPED_CLS}
    >
      {/* violations-suppress-start: tailwind/no-raw-color-class terminal palette - intentional dark theme separate from app theme tokens */}
      <div className={LOG_HEADER_CLS}>
        {runs.length > 1 && (
          /* violations-suppress: react/no-raw-input run selector - dark terminal palette incompatible with FieldText light-mode classes */
          <select
            value={selectedRun}
            onChange={e => handleSelectRun(e.target.value)}
            className={RUN_SELECT_CLS}
          >
            {runs.map((r, i) => (
              <option key={r.name} value={r.name}>{fmtRunName(r.name, i, runs.length)}</option>
            ))}
          </select>
        )}
        <span className="flex-1">
          {connected
            ? matchCount !== null ? `${matchCount} / ${lines.length} lines` : `${lines.length} lines`
            : 'Connecting...'}
        </span>
        <div className="flex items-center gap-2">
          {isJobRunning && (
            <ButtonAction
              label={killing ? 'Killing...' : 'Kill'}
              icon={<X size={12} />}
              variant="danger"
              size="sm"
              onClick={handleKillJob}
              disabled={killing}
              loading={killing}
            />
          )}
          {/* One control, and it IS the state indicator: green "Live" while following the tail, amber
              "Paused" when not. There used to be a separate amber badge beside it saying Paused while
              the button still read "Auto", which is how the two came to disagree - the badge and the
              button were reading different variables. Saying it once means they cannot.

              "Live" rather than "Auto" because it names what the reader sees - the pane is showing the
              log as it arrives - where "Auto" named the mechanism.

              The colour comes from ChipButton's own palettes, which resolve hue tokens, so it is
              correct inside the terminal's ThemeScope rather than a hard-coded yellow.

              ChipButton carries aria-pressed itself, which keeps the state readable rather than only
              visible, and is the only thing a test can hold it to. */}
          <ChipButton
            // Always `active`, because both states are a filled chip - a chip's inactive palette is
            // the muted grey one, so `active={autoScroll}` would drop the amber and leave Paused
            // looking switched off rather than paused. The colour carries the state.
            active
            color={autoScroll ? 'green' : 'yellow'}
            // The real toggle state, overriding the one ChipButton derives from `active`. Without this
            // the control would report itself as permanently pressed, which is the accessibility half
            // of the bug where the badge and the button disagreed.
            aria-pressed={autoScroll}
            shape="square"
            onClick={handleAutoScrollToggle}
            title={autoScroll ? 'Following the log - click to pause' : 'Paused - click to follow the log'}
          >
            {autoScroll ? <ArrowDown size={12} /> : <Pause size={12} />}
            {autoScroll ? 'Live' : 'Paused'}
          </ChipButton>
          {/* The same SearchBar the job list uses. It brings its own search icon, clear button
              and role=search, and the scoped tokens make it terminal-dark. debounceMs 0 keeps
              filtering per keystroke, which a log tail needs. */}
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search..."
            debounceMs={0}
          />
        </div>
      </div>
      <pre ref={containerRef} onScroll={handleScroll} className={LOG_BODY_CLS}>
        {filtered.length === 0 && connected
          ? <span className="text-muted">{search ? 'No matching lines.' : 'No log output yet'}</span>
          : filtered.map((line, i) => (
            <React.Fragment key={i}>
              {linkify(line, search || undefined, apiBase)}
              {i < filtered.length - 1 ? '\n' : null}
            </React.Fragment>
          ))}
      </pre>
      {/* violations-suppress-end: tailwind/no-raw-color-class */}
    </ThemeScope>
  );
}
