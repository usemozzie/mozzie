import * as React from 'react';

type Variant = 'default' | 'ghost' | 'outline' | 'destructive';
type Size = 'sm' | 'md' | 'icon';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClass: Record<Variant, string> = {
  default:     'bg-accent text-white hover:bg-blue-500 shadow-[0_0_0_1px_rgba(59,130,246,0.4)]',
  ghost:       'bg-transparent hover:bg-white/[0.06] text-text-muted hover:text-text',
  outline:     'border border-border bg-transparent hover:bg-surface text-text hover:border-border-bright',
  destructive: 'bg-state-danger/90 text-white hover:bg-state-danger',
};

const sizeClass: Record<Size, string> = {
  sm:   'px-2.5 py-1 text-xs h-7 rounded-md',
  md:   'px-3 py-1.5 text-sm h-8 rounded-lg',
  icon: 'w-7 h-7 p-0 flex items-center justify-center rounded-lg',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', className = '', ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center gap-1.5 font-medium transition-all duration-150
        disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-accent
        ${variantClass[variant]} ${sizeClass[size]} ${className}`}
      {...props}
    />
  )
);
Button.displayName = 'Button';
