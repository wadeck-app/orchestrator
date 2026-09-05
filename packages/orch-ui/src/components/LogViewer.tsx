import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

// Log viewer uses a fixed dark terminal palette separate from the app theme.
// Semantic tokens (bg-surface, text-content) would make the terminal look like
// the rest of the UI - wrong for a log tail component.
// violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname terminal/console pane must stay dark regardless of app theme; semantic surface tokens would invert on light mode
// @formatter:off
const LOG_HEADER_CLS = 'flex items-center gap-2 px-3 py-1.5 bg-gray-800 text-gray-400 text-xs rounded-t';
const LOG_BODY_CLS   = 'flex-1 overflow-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-b';
const SEARCH_CLS     = 'bg-gray-700 border border-gray-600 text-gray-200 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-gray-400 placeholder-gray-500';
// @formatter:on
// violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname

// Matches file:/// URLs, http(s) URLs, and Windows absolute paths with known extensions.
const URL_RE = /(file:\/\/\/[^\s\r\n]+|https?:\/\/[^\s\r\n]+|[A-Za-z]:[\\\/][^\s\r\n]+\.(?:html?|json|csv|txt|log))/gi;

function toFileUrl(raw: string): string {
  if (raw.startsWith('file:///') || raw.startsWith('http')) return raw;
  // Convert Windows path: C:\foo\bar.html -> file:///C:/foo/bar.html
  return 'file:///' + raw.replace(/\\/g, '/');
}

function linkify(line: string, highlight?: string): React.ReactNode {
  // First apply URL linkification, then highlight search term
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;

  const pushText = (text: string): void => {
    if (!highlight || !text) {
      parts.push(text);
      return;
    }
    // Highlight search term within text segment
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
    const href = toFileUrl(m[0]);
    parts.push(
      // violations-suppress: tailwind/no-raw-color-class link inside dark terminal - no semantic token for terminal-link color
      <a key={m.index} href={href} target="_blank" rel="noopener noreferrer"
        className="underline opacity-80 hover:opacity-100">{m[0]}</a>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) pushText(line.slice(last));
  return parts.length > 0 ? parts : line;
}

export interface LogViewerProps {
  jobId: string;
  apiBase?: string;
}

/**
 * @registryCategory composite
 * @registryTags log viewer streaming sse
 */
export function LogViewer({ jobId, apiBase = '' }: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLPreElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    setLines([]);
    setConnected(false);
    setPaused(false);
    userScrolledUp.current = false;

    const es = new EventSource(`${apiBase}/api/logs/${jobId}/stream`);
    es.onopen = () => { setConnected(true); };
    es.onmessage = (ev) => {
      setConnected(true);
      if (ev.data) setLines((prev) => [...prev, ev.data as string]);
    };
    es.onerror = () => { setConnected(false); };
    return () => { es.close(); };
  }, [jobId, apiBase]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || userScrolledUp.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    userScrolledUp.current = !atBottom;
    setPaused(!atBottom);
  };

  const filtered = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;
  const matchCount = search ? filtered.length : null;

  return (
    <div className="flex flex-col h-full">
      {/* violations-suppress-start: tailwind/no-raw-color-class terminal palette - intentional dark theme separate from app theme tokens */}
      <div className={LOG_HEADER_CLS}>
        <span className="flex-1">
          {connected
            ? matchCount !== null ? `${matchCount} / ${lines.length} lines` : `${lines.length} lines`
            : 'Connecting...'}
        </span>
        {paused && <span className="text-yellow-400">Paused</span>}
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
      <pre ref={containerRef} onScroll={handleScroll} className={LOG_BODY_CLS}>
        {filtered.length === 0 && connected
          ? <span className="text-gray-500">{search ? 'No matching lines.' : 'No log output yet'}</span>
          : filtered.map((line, i) => (
            <React.Fragment key={i}>
              {linkify(line, search || undefined)}
              {i < filtered.length - 1 ? '\n' : null}
            </React.Fragment>
          ))}
      </pre>
      {/* violations-suppress-end: tailwind/no-raw-color-class */}
    </div>
  );
}
