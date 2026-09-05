declare module 'pidusage' {
  interface Stat { cpu: number; memory: number; pid: number; ctime: number; elapsed: number; timestamp: number; }
  function pidusage(pid: number): Promise<Stat>;
  export = pidusage;
}
