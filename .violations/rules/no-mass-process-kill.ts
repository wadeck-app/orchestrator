import type { Rule, Violation } from '@wadeck-app/violations-rules'

export const rule: Rule = {
  id: 'local/no-mass-process-kill',
  tags: 'shared',
  defaultScope: ['**/*'],
  defaultSeverity: 'error',
  async check(files: string[], _config: Record<never, never>): Promise<Violation[]> {
    const violations: Violation[] = []
    // TODO: implement
    return violations
  },
}

export default rule
