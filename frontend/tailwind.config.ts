import type { Config } from 'tailwindcss';

/**
 * THE DESIGN TOKENS — 02-FRONTEND-IMPLEMENTATION-PLAN.md §9.1, build-order
 * step 0.
 *
 * ===========================================================================
 * THE SCALES ARE CLOSED, NOT SUGGESTED.
 *
 * Two themes x four breakpoints x two languages is sixteen renderings per
 * screen. Twenty screens with an open scale produce twenty variants and no
 * manual review catches it — so `spacing`, `fontSize`, `borderRadius` and
 * `transitionDuration` are REPLACED rather than extended. A value outside the
 * scale does not render small or slightly wrong; the utility does not exist.
 *
 * That silence is the one hazard of closing a scale, so `eslint.config.mjs`
 * carries `architecture/spacing-scale-only`, which turns `p-5` into a build
 * failure instead of an element with no padding.
 * ===========================================================================
 *
 * ===========================================================================
 * LAYOUT SIZES ARE NAMED, NOT SPACING.
 *
 * A sidebar is 16rem because that is how wide a sidebar is, not because 16rem
 * is four steps up a padding scale. Those live in `width`/`height` below with
 * names, which is what keeps them out of the spacing argument entirely.
 * ===========================================================================
 */

/** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 px. Nothing between (§9.1). */
const spacing = {
  0: '0px',
  px: '1px',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  6: '1.5rem',
  8: '2rem',
  12: '3rem',
  16: '4rem',
} as const;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    spacing,
    /**
     * 12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 px, with the line height baked in:
     * 1.25 for headings, 1.5 for body. BODY IS 16 MINIMUM — the primary users
     * are children on small phones, and 14px body is the single most common way
     * a product becomes unreadable on the device it was designed for.
     *
     * `sm` and `xs` exist for labels, badges and metadata. They are not body.
     */
    fontSize: {
      xs: ['0.75rem', { lineHeight: '1.5' }],
      sm: ['0.875rem', { lineHeight: '1.5' }],
      base: ['1rem', { lineHeight: '1.5' }],
      lg: ['1.125rem', { lineHeight: '1.5' }],
      xl: ['1.25rem', { lineHeight: '1.25' }],
      '2xl': ['1.5rem', { lineHeight: '1.25' }],
      '3xl': ['1.875rem', { lineHeight: '1.25' }],
      '4xl': ['2.25rem', { lineHeight: '1.25' }],
    },
    /** 4 · 8 · 12 · 16 · full. `card` is the 16px one, named for its use. */
    borderRadius: {
      none: '0px',
      sm: '0.25rem',
      DEFAULT: '0.5rem',
      md: '0.75rem',
      card: '1rem',
      full: '9999px',
    },
    /**
     * THREE ELEVATION LEVELS ONLY. A fourth shadow is a fourth opinion about
     * what is in front of what, and nothing in this product stacks that deep.
     */
    boxShadow: {
      none: 'none',
      raised: '0 12px 36px rgb(27 20 55 / 0.08)',
      overlay: '0 20px 48px rgb(27 20 55 / 0.14)',
      modal: '0 28px 64px rgb(27 20 55 / 0.22)',
    },
    /** 150 micro · 250 transition · 400 page. All disabled under reduced motion. */
    transitionDuration: {
      micro: '150ms',
      DEFAULT: '150ms',
      transition: '250ms',
      page: '400ms',
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      /**
       * DEVANAGARI NEEDS MORE LEADING THAN LATIN (§9.1). Applied on the body
       * element of a Hindi subtree, never per component — a component that
       * knows the language is a component that has to be edited for the third
       * one.
       */
      lineHeight: {
        heading: '1.25',
        body: '1.5',
        hindi: '1.6',
      },
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        logo: 'rgb(var(--logo) / <alpha-value>)',
        /**
         * THE ONLY WAY A COMPONENT MAY NAME A BRAND COLOUR. The value comes
         * from `data-theme` on the route-group layout — purple for a student,
         * orange for a parent. A component that writes `purple-600` renders
         * wrong in the parent application, which is why
         * `architecture/semantic-tailwind-only` rejects the literal.
         */
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          strong: 'rgb(var(--brand-strong) / <alpha-value>)',
          subtle: 'rgb(var(--brand-subtle) / <alpha-value>)',
          fg: 'rgb(var(--brand-fg) / <alpha-value>)',
        },
        /**
         * STATUS COLOURS ARE SHARED ACROSS BOTH THEMES, and one of them is a
         * product decision rather than a palette entry: THERE IS NO HARSH RED
         * "WRONG". An incorrect answer renders with `info` and "Not yet" copy.
         * `danger` is for destructive actions — revoking a link, cancelling a
         * subscription — and never for a child's answer.
         */
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },
      scale: {
        press: '0.98',
      },
      transitionProperty: {
        surface:
          'color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform',
      },
      maxWidth: {
        shell: '80rem',
        prose: '65ch',
      },
      /**
       * Clearance for the mobile bottom navigation — 112px, which is the bar
       * plus a comfortable gap plus the safe-area inset the bar adds itself.
       * A layout measurement, not a spacing step, so it is named. See the
       * header.
       */
      padding: {
        nav: '7rem',
      },
      /** Named layout sizes. See the header — these are not spacing. */
      width: {
        sidebar: '16rem',
        illustration: '7rem',
      },
      height: {
        illustration: '7rem',
        bar: '2.5rem',
        panel: '20rem',
      },
      minHeight: {
        /** 44px. Every interactive element, every breakpoint (§12). */
        control: '2.75rem',
        screen: '100vh',
      },
      minWidth: {
        control: '2.75rem',
      },
    },
  },
  plugins: [],
};

export default config;
