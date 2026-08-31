import { writeFileSync } from 'node:fs';

export class VbsLauncher {
  static write(vbsPath: string, nodePath: string, scriptPath: string, args: string[] = []): void {
    const extraArgs = args.length > 0 ? ' ' + args.map(a => `""${a}""`).join(' ') : '';
    writeFileSync(vbsPath, [
      'Dim oShell',
      'Set oShell = CreateObject("WScript.Shell")',
      `oShell.Run """${nodePath}"" ""${scriptPath}""${extraArgs}, 0, False`,
    ].join('\r\n'), 'utf8');
  }
}
