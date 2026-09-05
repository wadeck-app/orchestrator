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
    // tailwind.config.ts safelist entries ARE the raw color declarations - not component usage
    'packages/orch-app/tailwind.config.ts',
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
    // Dev scripts intentionally show build output - windowsHide would suppress it
    'cli/daemon-spawn-no-windows-hide': {
      $exclude: ['scripts/**'],
    },
    // DSL pages must decompose from dsl-ui primitives, not wrap entire pages in one monolithic component
    './.violations/rules/dsl-no-monolithic-page.ts': true,
  },
} satisfies ViolationsConfig
