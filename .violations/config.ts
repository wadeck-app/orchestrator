import type { ViolationsConfig } from '@wadeck-app/violations-rules'

export default {
  projectTags: ['ts', 'react', 'tailwind', 'cli'],
  globalExclude: [
    'node_modules/**',
    'dist/**',
    // Bundler output, gitignored like dist/ and simply missing from the line above. It accounted for
    // 7 of the 25 windowsHide findings -- esbuild inlining third-party spawn calls, none of it ours
    // to fix, and all of it regenerated on every build.
    '**/dist-bundle/**',
    'packages/orch-app/src/generated/**',
    'packages/orch-server/public/**',
    'packages/orchestrator-cli/server/**',
    // Assembled copy of the app-core module (ci/scripts/copy-app-module.sh), built output like server/.
    // Left in, its manifest.json would be judged as a module with the wrong folder name.
    'packages/orchestrator-cli/app-module/**',
    'packages/orchestrator-cli/bin/**',
    // Output of `app-core-cli package` (gitignored): a bundle of third-party code and a manifest in a folder
    // that is not named app-module-<name>, neither of which is ours to fix.
    'packages/*/dist-module/**',
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
    // Test files use 'C:/tmp' and 'C:/work' as job `cwd` DATA -- string payloads asserted on, never
    // resolved on disk -- plus Windows path literals for the VBS launcher's quoting rules. The
    // rule's premise ("silently fails in CI") does not apply to a value nothing opens.
    // Production uses of os.homedir() are suppressed individually instead, since each one is a
    // deliberate decision worth reading.
    'shared/no-out-of-repo-path': {
      $exclude: [
        '**/test/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.test.js',
      ],
    },
    // Package src/index.ts are public API surfaces, not internal barrel imports. The app-core module's two
    // entries are index.ts by contract (`app-core-cli check` requires src/backend/index.ts and
    // src/dsl-components/index.ts): they are entry points, not barrels.
    'ts/no-barrel-index': {
      $exclude: [
        'packages/*/src/index.ts',
        'packages/*/src/index.tsx',
        'packages/app-module-*/src/backend/index.ts',
        'packages/app-module-*/src/dsl-components/index.ts',
      ],
    },
    // This rule (scoped to the package.json next to the manifest) validates manifest.json against the schema of
    // the PACKAGED manifest (version, backendEntryPath and dslLib.entry required). The source manifest of the
    // new module layout has none of them by design: `package` writes them into dist-module/manifest.json.
    // `app-core-cli check` (npm run check) validates the source manifest and `package` validates the packaged
    // one, so the module is still covered.
    'app-module/manifest-exists-and-valid': {
      $exclude: ['packages/app-module-*/package.json'],
    },
    // Dev scripts intentionally show build output - windowsHide would suppress it.
    // packages/*/scripts/** is the same case and was not covered: 'scripts/**' does not match
    // packages/orchestrator-cli/scripts/build-tray-binary.ts, which is a build step whose output is
    // the point of running it.
    'cli/daemon-spawn-no-windows-hide': {
      $exclude: ['scripts/**', 'packages/*/scripts/**'],
    },
    // DSL pages must decompose from dsl-ui primitives, not wrap entire pages in one monolithic component
    './.violations/rules/dsl-no-monolithic-page.ts': true,
    // Icon buttons must not use text-muted on bg-muted-bg (insufficient contrast)
    './.violations/rules/no-low-contrast-icon-btn.ts': true,
  },
} satisfies ViolationsConfig
