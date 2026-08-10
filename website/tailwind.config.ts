import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        plum: 'rgb(var(--plum) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 18px 48px rgb(31 27 49 / 0.08)',
        lift: '0 24px 70px rgb(31 27 49 / 0.14)',
      },
      borderRadius: {
        card: '1.5rem',
        panel: '2rem',
      },
      maxWidth: {
        shell: '75rem',
      },
    },
  },
  plugins: [],
};

export default config;
