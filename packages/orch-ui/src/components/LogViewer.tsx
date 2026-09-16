import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, ArrowDown, Pause } from 'lucide-react';
import { getErrorMessage, isRunActive, latestRun, type RuntimeEntry } from '../types.js';

// Log viewer uses a fixed dark terminal palette separate from the app theme.
// Semantic tokens (bg-surface, text-content) would make the terminal look like
// the rest of the UI - wrong for a log tail component.
// violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname,react/no-raw-button terminal/console pane must stay dark regardless of app theme; semantic surface tokens would invert on light mode; Button component doesn't support icon+label in compact terminal header style
// @formatter:off
// min-h-0 lets the log pane shrink inside a flex parent; max-h bounds it when the host
// page provides no height, without which overflow-auto never scrolls and follow-tail
// would silently do nothing.
// [color-scheme:dark] makes the UA paint this widget's scrollbar, and the native
// select/input chrome in the toolbar, with its dark palette. It is set here and
// inherited rather than set on the pane alone, because the whole widget stays
// dark in the light theme - where an inherited light scheme yields a white
// scrollbar over a near-black pane.
const CONTAINER_BASE_CLS = 'flex flex-col min-h-0 [color-scheme:dark]';
// Fallback for hosts that give the widget no height: h-full would resolve to
// auto, so the pane would never overflow and follow-tail would silently do
// nothing. 75vh keeps it scrollable without the host's help.
const CONTAINER_CAPPED_CLS = `${CONTAINER_BASE_CLS} h-full max-h-[75vh]`;
// Claims the viewport minus the log page's chrome: NavBar (2.5rem) + PageContent's
// top and bottom p-4 (2rem) + the LogPageBreadcrumb row and the space-y-4 gap above
// it (2.25rem). DSL sections stack in a plain space-y container rather than a flex
// column, so flex-1 would collapse to nothing here.
const CONTAINER_FILL_CLS = `${CONTAINER_BASE_CLS} h-[calc(100vh-6.75rem)]`;
const LOG_HEADER_CLS     = 'flex items-center gap-2 px-3 py-1.5 bg-gray-800 text-gray-400 text-xs rounded-t';
const LOG_BODY_CLS       = 'flex-1 overflow-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-b';
const SEARCH_CLS         = 'bg-gray-700 border border-gray-600 text-gray-200 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-gray-400 placeholder-gray-500';
const RUN_SELECT_CLS     = 'bg-gray-700 border border-gray-600 text-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-gray-400 mr-2';
const KILL_BTN_CLS       = 'flex items-center gap-1 px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs transition-colors';
const AUTO_SCROLL_ON_CLS = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors bg-green-700 hover:bg-green-800 text-white';
const AUTO_SCROLL_OFF_CLS= 'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors bg-gray-700 hover:bg-gray-600 text-gray-300';
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
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedRun, setSelectedRun] = useState<string>(searchParams.get('run') ?? '');
  const [isJobRunning, setIsJobRunning] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [killing, setKilling] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);
  const userScrolledUp = useRef(false);

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
    setPaused(false);
    userScrolledUp.current = false;

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
    if (!el || !autoScroll || userScrolledUp.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    userScrolledUp.current = !atBottom;
    setPaused(!atBottom);
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
    setAutoScroll(!autoScroll);
    if (!autoScroll) {
      // Re-enable auto-scroll: scroll to bottom immediately
      userScrolledUp.current = false;
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  };

  const filtered = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;
  const matchCount = search ? filtered.length : null;

  return (
    <div className={fill ? CONTAINER_FILL_CLS : CONTAINER_CAPPED_CLS}>
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
        {paused && <span className="text-yellow-400">Paused</span>}
        <div className="flex items-center gap-2">
          {isJobRunning && (
            <button onClick={handleKillJob} disabled={killing} className={KILL_BTN_CLS} title="Kill running job">
              <X size={12} />
              {killing ? 'Killing...' : 'Kill'}
            </button>
          )}
          <button
            onClick={handleAutoScrollToggle}
            className={autoScroll ? AUTO_SCROLL_ON_CLS : AUTO_SCROLL_OFF_CLS}
            title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
          >
            {autoScroll ? <ArrowDown size={12} /> : <Pause size={12} />}
            Auto
          </button>
          <div className="flex items-center gap-1">
            <Search size={10} className="text-gray-500" />
            {/* violations-suppress: react/no-raw-input log search - FieldText requires light-mode classes incompatible with dark terminal */}
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={SEARCH_CLS}
            />
          </div>
        </div>
      </div>
      <pre ref={containerRef} onScroll={handleScroll} className={LOG_BODY_CLS}>
        {filtered.length === 0 && connected
          ? <span className="text-gray-500">{search ? 'No matching lines.' : 'No log output yet'}</span>
          : filtered.map((line, i) => (
            <React.Fragment key={i}>
              {linkify(line, search || undefined, apiBase)}
              {i < filtered.length - 1 ? '\n' : null}
            </React.Fragment>
          ))}
      </pre>
      {/* violations-suppress-end: tailwind/no-raw-color-class */}
    </div>
  );
}
