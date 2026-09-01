import type { ViolationsConfig } from '@wadeck/violations-rules'

export default {
  projectTags: ['ts', 'react', 'tailwind', 'shared', 'cli'],
  globalExclude: [
    'node_modules/**',
    'dist/**',
    'packages/orch-app/src/generated/**',
    'packages/orch-server/public/**',
    'packages/orchestrator-cli/server/**',
    'packages/orchestrator-cli/bin/**',
  ],
  rules: {
    // Atomic components ARE the button/input wrappers — excluded at config level
    // (entire file is the atomic implementation, inline suppress on every line would be noise)
    'react/no-raw-button': {
      $exclude: [
        'packages/orch-ui/src/components/TriggerButton.tsx',
        'packages/orch-ui/src/components/EnableToggle.tsx',
        'packages/orch-ui/src/components/Button.tsx',
      ],
    },
    'react/no-raw-input': {
      $exclude: [
        'packages/orch-ui/src/components/EnableToggle.tsx',
        'packages/orch-ui/src/components/FieldText.tsx',
        'packages/orch-ui/src/components/FieldNumber.tsx',
      ],
    },
    // Package src/index.ts are public API surfaces, not internal barrel imports
    'ts/no-barrel-index': {
      $exclude: [
        'packages/*/src/index.ts',
        'packages/*/src/index.tsx',
      ],
    },
  },
} satisfies ViolationsConfig
