declare module 'pidusage' {
  // ppid was missing here while being returned all along (verified against process.ppid on win32).
  // sampleProcessTree rebuilds the process tree from it, so an undeclared field would have been read
  // as always-undefined and every descendant silently dropped from the measurement.
  interface Stat { cpu: number; memory: number; pid: number; ppid: number; ctime: number; elapsed: number; timestamp: number; }
  function pidusage(pid: number): Promise<Stat>;
  /**
   * One look for several pids. A pid that is not running is absent from the answer (verified on win32: no
   * rejection), so a missing key means "not running".
   */
  function pidusage(pids: number[]): Promise<Record<number, Stat | undefined>>;
  export = pidusage;
}
