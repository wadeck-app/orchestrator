import type { Registry } from './registry.js';
import type { State } from './state.js';
import type { AuditLogger } from './audit.js';
import type { EventPublisher } from './event-publisher.js';
import type { Job } from './types.js';

/**
 * Command handlers: extracted from commands.ts for testability.
 * Each handler is independently testable and reusable.
 */

export class CommandHandlers {
  constructor(
    private registry: Registry,
    private state: State,
    private audit: AuditLogger | undefined,
    private events: EventPublisher,
  ) {}

  async addJob(payload: Record<string, unknown>): Promise<Job> {
    this.registry.add(payload as Partial<Job>);
    const job = this.registry.get((payload as { id: string }).id);
    if (!job) throw new Error('Failed to add job');
    this.audit?.log('job.added', { jobId: job.id, type: job.type });
    return job;
  }

  async listJobs(): Promise<Job[]> {
    return this.registry.list();
  }

  async getJob(payload: { id: string }): Promise<Job> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    return job;
  }

  async removeJob(payload: { id: string }): Promise<void> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    this.registry.remove(payload.id);
    this.audit?.log('job.removed', { jobId: payload.id });
  }

  async enableJob(payload: { id: string }): Promise<Job> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    this.registry.edit(payload.id, { enabled: true });
    this.audit?.log('job.enabled', { jobId: payload.id });
    return this.registry.get(payload.id)!;
  }

  async disableJob(payload: { id: string }): Promise<Job> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    this.registry.edit(payload.id, { enabled: false });
    this.audit?.log('job.disabled', { jobId: payload.id });
    return this.registry.get(payload.id)!;
  }

  async editJob(payload: { id: string; updates?: Record<string, unknown> }): Promise<Job> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    const updates = payload.updates ?? {};
    this.registry.edit(payload.id, updates as Partial<Job>);
    this.audit?.log('job.edited', { jobId: payload.id, updates });
    return this.registry.get(payload.id)!;
  }

  async listState(): Promise<Record<string, unknown>> {
    return this.state.getAll();
  }

  async getUptime(): Promise<Record<string, number | null>> {
    const result: Record<string, number | null> = {};
    for (const job of this.registry.list()) {
      result[job.id] = this.state.getUptimePercent(job.id) ?? null;
    }
    return result;
  }

  async triggerJob(payload: { id: string; wait?: boolean; ip?: string; userAgent?: string }): Promise<{ exitCode?: number; pid?: number }> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    if (!job.enabled) throw new Error(`Job is disabled: "${payload.id}"`);

    this.audit?.log('job.triggered', { jobId: payload.id, manual: true, ip: payload.ip, userAgent: payload.userAgent });
    this.events.publish('job.triggered', { jobId: payload.id, manual: true });

    // Note: actual job execution happens in scheduler
    // This is a notification handler only
    return { pid: undefined };
  }

  async skipNextFiring(payload: { id: string }): Promise<void> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);
    // Implementation: scheduler checks this flag
    this.audit?.log('job.skip_next', { jobId: payload.id });
  }

  async killJob(payload: { id: string; ip?: string; userAgent?: string }): Promise<{ killed: boolean }> {
    const job = this.registry.get(payload.id);
    if (!job) throw new Error(`Job not found: "${payload.id}"`);

    this.audit?.log('job.kill_requested', { jobId: payload.id, ip: payload.ip, userAgent: payload.userAgent });
    this.events.publish('job.kill_requested', { jobId: payload.id });

    // Note: actual kill happens in scheduler
    return { killed: false };
  }
}
