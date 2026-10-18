import fs from 'node:fs';
import { atomicWriteJson } from './fsUtil.js';
import { getErrorMessage } from './fsUtil.js';

/**
 * The groups of things that happen when a run ends, in the order they are done:
 *
 * - `state`: the history entry (flushed to disk), the log marker, the signal the audit listens to.
 * - `actions`: what ACTS on the world, i.e. retry, dependents and their hooks. Marked BEFORE they run, so a daemon
 *   that dies halfway never runs them twice (it may, rarely, not finish them, which is the lesser harm).
 * - `events`: what is published to the queue. Marked after: a replay may deliver an event twice, never lose one.
 */
export type EffectGroup = 'state' | 'actions' | 'events';

/**
 * Which groups of a run's end have been done, kept in the run folder (`effects.json`) so that a daemon which
 * dies in the middle of handling an end, and finds it again at its next start, repeats only what is missing.
 */
export class EffectLedger {
  constructor(private readonly _file: string) {}

  done(group: EffectGroup): boolean {
    return this._read()[group] === true;
  }

  mark(group: EffectGroup): void {
    atomicWriteJson(this._file, { ...this._read(), [group]: true });
  }

  private _read(): Partial<Record<EffectGroup, boolean>> {
    let raw: string;
    try {
      raw = fs.readFileSync(this._file, 'utf8');
    } catch {
      // No ledger yet: nothing has been done.
      return {};
    }
    try {
      return JSON.parse(raw) as Partial<Record<EffectGroup, boolean>>;
    } catch (err) {
      // Said, not hidden: with no usable ledger every group is repeated, so an event can be delivered twice.
      try { process.stderr.write(`[effect-ledger] ${this._file} is unreadable (${getErrorMessage(err)}), treating nothing as done\n`); } catch { /* EPIPE */ }
      return {};
    }
  }
}
