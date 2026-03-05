import * as React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full bg-surface border border-border rounded px-3 py-1.5 text-sm text-text
        placeholder:text-text-dim focus:outline-none focus:border-accent transition-colors ${className}`}
      {...props}
    />
  )
);
Input.displayName = 'Input';
