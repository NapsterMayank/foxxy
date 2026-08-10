import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        logo: 'rgb(var(--logo) / <alpha-value>)',
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          strong: 'rgb(var(--brand-strong) / <alpha-value>)',
          subtle: 'rgb(var(--brand-subtle) / <alpha-value>)',
        },
      },
      boxShadow: {
        raised: '0 12px 36px rgb(27 20 55 / 0.08)',
        overlay: '0 20px 48px rgb(27 20 55 / 0.14)',
      },
      scale: {
        press: '0.98',
      },
      transitionProperty: {
        surface:
          'color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform',
      },
      borderRadius: {
        card: '1rem',
      },
      maxWidth: {
        shell: '80rem',
      },
      minHeight: {
        control: '2.75rem',
      },
      minWidth: {
        control: '2.75rem',
      },
    },
  },
  plugins: [],
};

export default config;
