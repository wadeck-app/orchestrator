import type { ViolationsConfig } from '@wadeck/violations-rules'

export default {
  projectTags: ['ts', 'shared'],
  globalExclude: [
    'node_modules/**',
    'dist/**',
  ],
  rules: {},
} satisfies ViolationsConfig
