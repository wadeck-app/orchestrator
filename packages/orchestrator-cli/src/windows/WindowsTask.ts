import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { VbsLauncher } from './VbsLauncher.js';

const WSCRIPT_EXE = 'C:\\Windows\\System32\\wscript.exe';

interface WindowsTaskOptions {
  taskName:    string;
  projectDir:  string;
  nodePath:    string;
  runnerJs:    string;
  launcherVbs: string;
  schedule1:   string;
  schedule2:   string;
  description: string;
}

interface RunResult {
  ok:  boolean;
  out: string;
  err: string;
}

export class WindowsTask {
  private readonly taskName:    string;
  private readonly projectDir:  string;
  private readonly nodePath:    string;
  private readonly runnerJs:    string;
  private readonly launcherVbs: string;
  private readonly schedule1:   string;
  private readonly schedule2:   string;
  private readonly description: string;

  constructor(opts: WindowsTaskOptions) {
    this.taskName    = opts.taskName;
    this.projectDir  = opts.projectDir;
    this.nodePath    = opts.nodePath;
    this.runnerJs    = opts.runnerJs;
    this.launcherVbs = opts.launcherVbs;
    this.schedule1   = opts.schedule1;
    this.schedule2   = opts.schedule2;
    this.description = opts.description;
  }

  private _run(args: string[]): RunResult {
    const result = spawnSync('schtasks.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    return {
      ok:  result.status === 0,
      out: (result.stdout ?? '').trim(),
      err: (result.stderr ?? '').trim(),
    };
  }

  install(): void {
    VbsLauncher.write(this.launcherVbs, this.nodePath, this.runnerJs);
    // violations-suppress: shared/no-emoji local/no-unicode-symbol Windows task installer output - intentional terminal indicator
    console.log(`✓ Launcher written: ${this.launcherVbs}`);

    const xmlPath = path.join(os.tmpdir(), `${this.taskName}-setup.xml`);
    const today   = new Date().toISOString().slice(0, 10);

    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${this.description}</Description>
    <Author>${os.userInfo().username}</Author>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${today}T${this.schedule1}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <CalendarTrigger>
      <StartBoundary>${today}T${this.schedule2}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${WSCRIPT_EXE}</Command>
      <Arguments>"${this.launcherVbs}"</Arguments>
      <WorkingDirectory>${this.projectDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

    const buf = Buffer.concat([Buffer.from('\xFF\xFE', 'binary'), Buffer.from(xml, 'utf16le')]);
    writeFileSync(xmlPath, buf);

    const importR = this._run(['/Create', '/F', '/TN', this.taskName, '/XML', xmlPath]);
    try { unlinkSync(xmlPath); } catch {}

    if (!importR.ok) {
      // violations-suppress: shared/no-emoji local/no-unicode-symbol Windows task installer output - intentional terminal indicator
      console.error(`✗ Could not register task:\n${importR.out}\n${importR.err}`);
      process.exit(1);
    }

    // violations-suppress: shared/no-emoji local/no-unicode-symbol Windows task installer output - intentional terminal indicator
    console.log(`✓ Task "${this.taskName}" installed - runs daily at ${this.schedule1} and ${this.schedule2}.`);
    console.log(`  Node:        ${this.nodePath}`);
    console.log(`  Launcher:    ${this.launcherVbs}`);
    console.log(`  Runner:      ${this.runnerJs}`);
    console.log(`  Description: "${this.description}"`);
    console.log(`\n  To verify: node scripts/setup-task.js --status`);
    console.log(`  To uninstall: node scripts/setup-task.js --uninstall`);
  }

  uninstall(): void {
    const r = this._run(['/Delete', '/TN', this.taskName, '/F']);
    if (r.ok) {
      console.log(`OK: Task "${this.taskName}" uninstalled.`);
    } else {
      console.error(`ERROR: Failed to uninstall task:\n${r.out}\n${r.err}`);
      process.exit(1);
    }
  }

  status(): void {
    const r = this._run(['/Query', '/TN', this.taskName, '/FO', 'LIST']);
    if (r.ok) {
      console.log(r.out);
    } else {
      console.log(`Task "${this.taskName}" not found.`);
    }
  }
}
