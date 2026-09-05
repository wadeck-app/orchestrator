import type { Job, RuntimeEntry } from './types.js';

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  headers?: Record<string, string>;
}

export interface JobWithState {
  job: Job;
  runHistory: RuntimeEntry[];
}

export interface FailureEntry {
  jobId: string;
  entry: RuntimeEntry;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error((err as { error: string }).error ?? res.statusText), { status: res.status });
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listJobs: () => apiFetch<JobWithState[]>('/api/jobs'),
  getJob: (id: string) => apiFetch<JobWithState>(`/api/jobs/${id}`),
  addJob: (data: Partial<Job>) =>
    apiFetch<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(data) }),
  editJob: (id: string, data: Partial<Job>) =>
    apiFetch<Job>(`/api/jobs/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteJob: (id: string) =>
    apiFetch<void>(`/api/jobs/${id}`, { method: 'DELETE' }),
  triggerJob: (id: string) =>
    apiFetch<void>(`/api/jobs/${id}/trigger`, { method: 'POST' }),
  enableJob: (id: string) =>
    apiFetch<void>(`/api/jobs/${id}/enable`, { method: 'POST' }),
  disableJob: (id: string) =>
    apiFetch<void>(`/api/jobs/${id}/disable`, { method: 'POST' }),
  listFailures: () =>
    apiFetch<FailureEntry[]>('/api/failures'),
  acknowledgeFailures: () =>
    apiFetch<void>('/api/failures/ack', { method: 'POST', body: '{}' }),
  listAudit: (limit = 100) =>
    apiFetch<Array<{ ts: string; event: string; [key: string]: unknown }>>(`/api/audit?limit=${limit}`),
  getSchedule: () =>
    apiFetch<Array<{ jobId: string; label: string; next: string[] }>>('/api/schedule'),
  getUptime: () =>
    apiFetch<Record<string, number | null>>('/api/uptime'),
  exportJobs: async () => {
    const res = await fetch('/api/jobs/export');
    if (!res.ok) throw new Error(res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orchestrator-jobs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
  importJobs: (data: { jobs: unknown[] }) =>
    apiFetch<{ imported: number }>('/api/jobs/import', { method: 'POST', body: JSON.stringify(data) }),
  listWebhooks: () =>
    apiFetch<WebhookConfig[]>('/api/webhooks'),
  addWebhook: (wh: WebhookConfig) =>
    apiFetch<{ ok: boolean }>('/api/webhooks', { method: 'POST', body: JSON.stringify(wh) }),
  removeWebhook: (id: string) =>
    apiFetch<void>(`/api/webhooks/${id}`, { method: 'DELETE' }),
  toggleWebhook: (id: string) =>
    apiFetch<WebhookConfig | null>(`/api/webhooks/${id}/toggle`, { method: 'PATCH', body: '{}' }),
};
