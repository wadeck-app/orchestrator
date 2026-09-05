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
      },
    },
  },
  safelist: [
    // JobStatusBadge fixed palette (no semantic token at this granularity)
    'bg-yellow-100', 'text-yellow-800',
    'bg-green-100',  'text-green-800',
    'bg-red-100',    'text-red-800',
    'bg-gray-100',   'text-gray-600',
    // JobCard type badge colors
    'bg-purple-100', 'text-purple-700',
    'bg-blue-100',   'text-blue-700',
    // LogViewer terminal palette
    'bg-gray-800', 'text-gray-400', 'text-yellow-400',
    'bg-gray-900', 'text-green-400', 'text-gray-500',
    // EnableToggle peer-checked colors
    'bg-gray-300', 'peer-checked:bg-blue-600', 'after:bg-white',
  ],
  plugins: [],
} satisfies Config;
