import * as React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text
        placeholder:text-text-dim focus:outline-none focus:border-accent transition-colors
        resize-y min-h-[80px] ${className}`}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';
