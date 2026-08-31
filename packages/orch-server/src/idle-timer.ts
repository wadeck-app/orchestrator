export class IdleTimer {
  private readonly _timeoutMs: number;
  private readonly _onIdle: () => void;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _sseCount = 0;

  constructor(timeoutMs: number, onIdle: () => void) {
    this._timeoutMs = timeoutMs;
    this._onIdle = onIdle;
  }

  reset(): void {
    if (this._sseCount > 0) return;
    this._clearTimer();
    this._startTimer();
  }

  addSseConnection(): void {
    this._sseCount++;
    this._clearTimer();
  }

  removeSseConnection(): void {
    this._sseCount = Math.max(0, this._sseCount - 1);
    if (this._sseCount === 0) this._startTimer();
  }

  stop(): void {
    this._clearTimer();
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _startTimer(): void {
    this._timer = setTimeout(() => this._onIdle(), this._timeoutMs);
  }
}
