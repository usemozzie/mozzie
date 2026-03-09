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
        bg: '#1a1e24',
        surface: '#232830',
        'surface-raised': '#2a3038',
        border: '#2d3340',
        'border-bright': '#3d4450',
        text: '#d4d4d8',
        'text-muted': '#7a8190',
        'text-dim': '#4a5060',
        accent: '#10B981',
        'accent-dim': 'rgba(16,185,129,0.12)',
        'accent-coral': '#e85d75',

        // Traffic-light state palette
        'state-idle': '#5a6170',
        'state-active': '#38BDF8',
        'state-waiting': '#F59E0B',
        'state-success': '#10B981',
        'state-danger': '#EF4444',
      },
    },
  },
  plugins: [],
};

export default config;
