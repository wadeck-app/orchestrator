import React, { useEffect, useState } from 'react';
import { Bell, Trash2, ToggleLeft, ToggleRight, Plus } from 'lucide-react';
import { getErrorMessage } from '../types.js';

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  headers?: Record<string, string>;
}

export interface WebhookListProps {
  apiBase?: string;
}

const WEBHOOK_EVENTS = [
  'job.failed',
  'job.recovered',
  'job.completed',
  'job.started',
  'job.timed_out',
  'job.anomaly',
  'alert.consecutive_failures',
];

// @formatter:off
const TABLE_CLS  = 'w-full text-sm border-collapse';
const TH_CLS     = 'pb-2 text-left font-medium text-muted border-b border-border';
const TD_CLS     = 'py-2 pr-4 align-middle';
const INPUT_CLS  = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
const BTN_P_CLS  = 'px-3 py-1.5 rounded bg-primary text-on-primary text-sm font-medium hover:bg-primary-hover';
// @formatter:on

/**
 * @registryCategory composite
 * @registryTags webhook notification
 */
export function WebhookList({ apiBase = '' }: WebhookListProps): React.ReactElement {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set(['job.failed', 'job.recovered']));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    fetch(`${apiBase}/api/webhooks`).then(r => r.json()).then((data: WebhookConfig[]) => setWebhooks(data)).catch(() => setWebhooks([]));
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (): Promise<void> => {
    if (!url.trim() || selectedEvents.size === 0) return;
    setSaving(true); setError(null);
    try {
      const wh: WebhookConfig = {
        id: `wh-${Date.now()}`,
        url: url.trim(),
        events: [...selectedEvents],
        enabled: true,
      };
      const res = await fetch(`${apiBase}/api/webhooks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wh),
      });
      if (!res.ok) throw new Error(res.statusText);
      setUrl(''); setSelectedEvents(new Set(['job.failed', 'job.recovered']));
      load();
    } catch (e) { setError(getErrorMessage(e)); } finally { setSaving(false); }
  };

  const handleRemove = async (id: string): Promise<void> => {
    await fetch(`${apiBase}/api/webhooks/${id}`, { method: 'DELETE' });
    load();
  };

  const handleToggle = async (id: string): Promise<void> => {
    await fetch(`${apiBase}/api/webhooks/${id}/toggle`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    load();
  };

  const toggleEvent = (ev: string): void => {
    setSelectedEvents(prev => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev); else next.add(ev);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-content flex items-center gap-2">
        <Bell size={18} className="text-primary" />Webhooks
      </h2>

      {/* Existing webhooks */}
      {webhooks.length > 0 && (
        <table className={TABLE_CLS}>
          <thead>
            <tr>
              <th className={TH_CLS}>URL</th>
              <th className={TH_CLS}>Events</th>
              <th className={TH_CLS}>Status</th>
              <th className={TH_CLS} />
            </tr>
          </thead>
          <tbody>
            {webhooks.map(wh => (
              <tr key={wh.id} className="border-b border-border">
                <td className={`${TD_CLS} font-mono text-xs max-w-xs truncate`}>{wh.url}</td>
                <td className={`${TD_CLS} text-xs text-muted`}>{wh.events.join(', ')}</td>
                <td className={TD_CLS}>
                  {/* violations-suppress: react/no-raw-button icon-only toggle - no Button variant for compact icon-only toggle */}
                  <button onClick={() => void handleToggle(wh.id)} title={wh.enabled ? 'Disable' : 'Enable'} className="text-muted hover:text-content">
                    {wh.enabled ? <ToggleRight size={16} className="text-primary" /> : <ToggleLeft size={16} />}
                  </button>
                </td>
                <td className={TD_CLS}>
                  {/* violations-suppress: react/no-raw-button icon-only delete - no Button variant for compact icon-only action */}
                  <button onClick={() => void handleRemove(wh.id)} title="Delete" className="text-muted hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {webhooks.length === 0 && <p className="text-sm text-muted italic">No webhooks configured.</p>}

      {/* Add webhook form */}
      <div className="rounded border border-border p-4 space-y-3">
        <p className="text-sm font-medium text-content flex items-center gap-1"><Plus size={14} />Add webhook</p>
        <input className={INPUT_CLS} type="url" placeholder="https://example.com/webhook" value={url} onChange={e => setUrl(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.map(ev => (
            <label key={ev} className="flex items-center gap-1 text-xs text-muted cursor-pointer">
              {/* violations-suppress: react/no-raw-input compact event checkbox - no FieldText variant for boolean without label */}
              <input type="checkbox" checked={selectedEvents.has(ev)} onChange={() => toggleEvent(ev)} className="accent-primary" />
              {ev}
            </label>
          ))}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {/* violations-suppress: react/no-raw-button form submit button with disabled state - Button component doesn't support async disabled pattern here */}
        <button onClick={() => void handleAdd()} disabled={saving || !url.trim()} className={BTN_P_CLS}>
          {saving ? 'Saving...' : 'Add webhook'}
        </button>
      </div>
    </div>
  );
}
