import React, { useEffect, useRef, useState } from 'react';

interface Props {
  jobId: string;
  apiBase?: string;
}

export function LogViewer({ jobId, apiBase = '' }: Props): React.ReactElement {
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

    es.onmessage = (ev) => {
      setConnected(true);
      setLines((prev) => [...prev, ev.data as string]);
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
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 text-gray-400 text-xs rounded-t">
        <span>{connected ? `${lines.length} lines` : 'Connecting...'}</span>
        {paused && (
          <span className="text-yellow-400">Paused (scrolled up)</span>
        )}
      </div>
      <pre
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-b"
      >
        {lines.length === 0 && !connected
          ? <span className="text-gray-500">Connecting...</span>
          : lines.length === 0
          ? <span className="text-gray-500">No log output yet</span>
          : lines.join('\n')}
      </pre>
    </div>
  );
}
