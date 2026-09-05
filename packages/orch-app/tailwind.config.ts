import type { Config } from 'tailwindcss';

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../orch-ui/src/**/*.{ts,tsx}',
    '../../node_modules/@wadeck-app/dsl-ui/src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary:        'var(--color-primary)',
        'primary-hover':'var(--color-primary-hover)',
        'on-primary':   'var(--color-on-primary)',
        bg:             'var(--color-bg)',
        surface:        'var(--color-surface)',
        border:         'var(--color-border)',
        content:        'var(--color-text)',
        muted:          'var(--color-text-muted)',    // text-muted = #6b7280
        'muted-bg':     'var(--color-muted-bg)',       // bg-muted-bg = #f3f4f6 (light bg)
        success:        'var(--color-success)',
        'success-subtle': 'var(--color-success-bg)',
        danger:         'var(--color-danger)',
        'danger-subtle':'var(--color-danger-bg)',
        warning:        'var(--color-warning)',
        'warning-subtle':'var(--color-warning-bg)',
        'tag-1': 'var(--color-tag-1)',
        'tag-2': 'var(--color-tag-2)',
        'tag-3': 'var(--color-tag-3)',
        'tag-4': 'var(--color-tag-4)',
        'tag-5': 'var(--color-tag-5)',
        'tag-6': 'var(--color-tag-6)',
        'tag-cron':        'var(--color-tag-cron)',
        'tag-cron-bg':     'var(--color-tag-cron-bg)',
        'tag-startup':     'var(--color-tag-startup)',
        'tag-startup-bg':  'var(--color-tag-startup-bg)',
        'tag-once':        'var(--color-tag-once)',
        'tag-once-bg':     'var(--color-tag-once-bg)',
      },
    },
  },
  safelist: [
    // JobStatusBadge fixed palette (no semantic token at this granularity)
    'bg-yellow-100', 'text-yellow-800',
    'bg-green-100',  'text-green-800',
    'bg-red-100',    'text-red-800',
    'bg-gray-100',   'text-gray-600',
    // JobCard type badge colors (semantic tokens, dark-mode aware)
    'bg-tag-cron-bg', 'text-tag-cron',
    'bg-tag-startup-bg', 'text-tag-startup',
    'bg-tag-once-bg', 'text-tag-once',
    // LogViewer terminal palette
    'bg-gray-800', 'text-gray-400', 'text-yellow-400',
    'bg-gray-900', 'text-green-400', 'text-gray-500',
    // EnableToggle peer-checked colors
    'bg-gray-300', 'peer-checked:bg-blue-600', 'after:bg-white',
    // Tag palette (dynamically chosen by hash)
    'bg-tag-1','bg-tag-2','bg-tag-3','bg-tag-4','bg-tag-5','bg-tag-6',
    'text-tag-1','text-tag-2','text-tag-3','text-tag-4','text-tag-5','text-tag-6',
  ],
  plugins: [],
} satisfies Config;
