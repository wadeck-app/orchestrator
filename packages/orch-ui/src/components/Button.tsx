import React from 'react';

export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'danger' | 'secondary';
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit';
}

// @formatter:off
const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:   'bg-primary text-on-primary hover:bg-primary-hover',
  danger:    'bg-danger text-on-primary hover:opacity-90',
  secondary: 'bg-surface text-content border border-border hover:bg-muted',
};
// @formatter:on

/**
 * @registryCategory atomic
 * @registryTags button action
 */
export function Button({ label, variant = 'primary', onClick, disabled, loading, type = 'button' }: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled ?? loading}
      className={`px-4 py-2 text-sm rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]}`}
    >
      {loading ? 'Loading...' : label}
    </button>
  );
}
