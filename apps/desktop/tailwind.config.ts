import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0F172A',
        surface: '#1E293B',
        'surface-raised': '#273548',
        border: '#334155',
        'border-bright': '#475569',
        text: '#F1F5F9',
        'text-muted': '#94A3B8',
        'text-dim': '#475569',
        accent: '#3B82F6',
        'accent-dim': 'rgba(59,130,246,0.15)',

        // Traffic-light state palette
        'state-idle': '#64748B',
        'state-active': '#3B82F6',
        'state-waiting': '#F59E0B',
        'state-success': '#10B981',
        'state-danger': '#EF4444',
      },
    },
  },
  plugins: [],
};

export default config;
