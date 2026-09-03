import React, { useEffect, useRef, useState } from 'react';

// Log viewer uses a fixed dark terminal palette separate from the app theme.
// Semantic tokens (bg-surface, text-content) would make the terminal look like
// the rest of the UI - wrong for a log tail component.
// violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname terminal/console pane must stay dark regardless of app theme; semantic surface tokens would invert on light mode
// @formatter:off
const LOG_HEADER_CLS = 'flex items-center justify-between px-3 py-1.5 bg-gray-800 text-gray-400 text-xs rounded-t';
const LOG_BODY_CLS   = 'flex-1 overflow-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-b';
// @formatter:on
// violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname

const URL_RE = /(file:\/\/\/[^\s]+|https?:\/\/[^\s]+)/g;

function linkify(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      // violations-suppress: tailwind/no-raw-color-class link inside dark terminal — no semantic token for terminal-link color
      <a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer"
        className="underline opacity-80 hover:opacity-100">{m[0]}</a>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
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

    es.onerror = () => {
      setConnected(false);
    };

    return () => { es.close(); };
  }, [jobId, apiBase]);

  // Auto-scroll to bottom when new lines arrive, unless user scrolled up
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

  return (
    <div className="flex flex-col h-full">
      {/* violations-suppress-start: tailwind/no-raw-color-class terminal palette - intentional dark theme separate from app theme tokens */}
      <div className={LOG_HEADER_CLS}>
        <span>{connected ? `${lines.length} lines` : 'Connecting...'}</span>
        {paused && (
          <span className="text-yellow-400">Paused (scrolled up)</span>
        )}
      </div>
      <pre
        ref={containerRef}
        onScroll={handleScroll}
        className={LOG_BODY_CLS}
      >
        {lines.length === 0 && connected
          ? <span className="text-gray-500">No log output yet</span>
          : lines.map((line, i) => (
            <React.Fragment key={i}>
              {linkify(line)}
              {i < lines.length - 1 ? '\n' : null}
            </React.Fragment>
          ))}
      </pre>
      {/* violations-suppress-end: tailwind/no-raw-color-class */}
    </div>
  );
}
