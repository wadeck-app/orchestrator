import { writeFileSync } from 'node:fs';

/** Escapes a string for embedding inside a VBScript string literal (a quote is doubled). */
export function vbsEscape(s: string): string {
  return s.replace(/"/g, '""');
}

export class VbsLauncher {
  /**
   * Single place that knows how to spell a hidden `oShell.Run` line.
   *
   * The argument is a VBScript string literal that itself holds a quoted command line: the
   * literal opens with `"`, every embedded quote is doubled, and it must close with its own
   * `"`. Two generators (here and cli.ts) each omitted that closing quote, so the literal
   * stayed open and Windows Script Host reported "unterminated string constant" at line 4
   * instead of starting anything. Neither was covered by a test, and neither escaped the
   * paths it interpolated.
   */
  static runLine(exePath: string, args: string[] = []): string {
    const quoted = [exePath, ...args].map((a) => `""${vbsEscape(a)}""`).join(' ');
    return `oShell.Run "${quoted}", 0, False`;
  }

  static write(vbsPath: string, nodePath: string, scriptPath: string, args: string[] = []): void {
    writeFileSync(vbsPath, [
      'Dim oShell',
      'Set oShell = CreateObject("WScript.Shell")',
      VbsLauncher.runLine(nodePath, [scriptPath, ...args]),
    ].join('\r\n'), 'utf8');
  }
}
