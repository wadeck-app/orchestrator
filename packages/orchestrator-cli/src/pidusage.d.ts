declare module 'pidusage' {
  // ppid was missing here while being returned all along (verified against process.ppid on win32).
  // sampleProcessTree rebuilds the process tree from it, so an undeclared field would have been read
  // as always-undefined and every descendant silently dropped from the measurement.
  interface Stat { cpu: number; memory: number; pid: number; ppid: number; ctime: number; elapsed: number; timestamp: number; }
  function pidusage(pid: number): Promise<Stat>;
  export = pidusage;
}
