import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: { DEFAULT: 'hsl(var(--success))', soft: 'hsl(var(--success-soft))' },
        warning: { DEFAULT: 'hsl(var(--warning))', soft: 'hsl(var(--warning-soft))' },
        danger: { DEFAULT: 'hsl(var(--danger))', soft: 'hsl(var(--danger-soft))' },
        info: { DEFAULT: 'hsl(var(--info))', soft: 'hsl(var(--info-soft))' },
        neutral: { DEFAULT: 'hsl(var(--neutral))', soft: 'hsl(var(--neutral-soft))' },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.05), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        popover: '0 8px 24px -4px rgb(16 24 40 / 0.14)',
      },
      fontSize: {
        'page-title': [
          '1.5rem',
          { lineHeight: '2rem', fontWeight: '600', letterSpacing: '-0.01em' },
        ],
        'section-title': ['1.125rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        'card-title': ['1rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        metric: ['1.5rem', { lineHeight: '2rem', fontWeight: '600', letterSpacing: '-0.01em' }],
      },
    },
  },
  plugins: [animate],
}
export default config
