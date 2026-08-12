import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

function staticClassName(node) {
  if (node.value?.type === 'Literal' && typeof node.value.value === 'string') {
    return node.value.value;
  }

  if (
    node.value?.type === 'JSXExpressionContainer' &&
    node.value.expression.type === 'Literal' &&
    typeof node.value.expression.value === 'string'
  ) {
    return node.value.expression.value;
  }

  return null;
}

const architecturePlugin = {
  rules: {
    'no-cross-feature-imports': {
      meta: {
        type: 'problem',
        messages: {
          sharedImportsFeature: 'Shared components must not depend on a product feature.',
          featureImportsFeature: 'A feature must not import another feature directly.',
        },
      },
      create(context) {
        const filename = context.filename.replaceAll('\\', '/');
        const featureMatch = filename.match(/\/src\/features\/([^/]+)\//);
        const inSharedComponents = filename.includes('/src/components/');

        return {
          ImportDeclaration(node) {
            const source = String(node.source.value);
            const importedFeature = source.match(/^@\/features\/([^/]+)/)?.[1];
            if (!importedFeature) return;

            if (inSharedComponents) {
              context.report({ node, messageId: 'sharedImportsFeature' });
            } else if (featureMatch && featureMatch[1] !== importedFeature) {
              context.report({ node, messageId: 'featureImportsFeature' });
            }
          },
        };
      },
    },
    /**
     * NO USER-FACING STRING LITERALS — plan §8, and a §10.7 CI gate.
     *
     * "No literal user-facing string in a component. Ever. Enforced by an
     * ESLint rule rejecting string literals in JSX text nodes."
     *
     * Without it, translation coverage is a thing somebody remembers, and the
     * failure is invisible to everybody working in English: one English
     * sentence in the middle of a Hindi screen, on the screen nobody reviewed
     * in Hindi.
     *
     * IT ALSO COVERS FOUR PROPS, which the plan's wording does not name and
     * which are every bit as user-facing: `aria-label` and `title` are read
     * aloud, `placeholder` is read on screen, and `alt` is the whole content
     * for somebody who cannot see the image. An untranslated `aria-label` is a
     * screen reader switching language mid-sentence.
     *
     * PUNCTUATION AND SYMBOLS PASS. `·`, `→`, `↓`, `*` and digits carry no
     * language, and routing them through a dictionary would add keys nobody
     * translates while making the markup harder to read.
     */
    'no-literal-jsx-text': {
      meta: {
        type: 'problem',
        messages: {
          text: 'User-facing text "{{text}}" must come from the dictionary — see lib/i18n.',
          prop: '"{{prop}}" is read by users or screen readers; take it from the dictionary.',
        },
      },
      create(context) {
        // At least one letter in any script. Digits and symbols alone are fine.
        const hasWords = /\p{L}/u;
        const translatableProps = new Set(['aria-label', 'alt', 'placeholder', 'title']);

        return {
          JSXText(node) {
            const value = String(node.value).trim();
            if (value.length === 0 || !hasWords.test(value)) return;
            context.report({ node, messageId: 'text', data: { text: value.slice(0, 40) } });
          },
          JSXAttribute(node) {
            const name = typeof node.name.name === 'string' ? node.name.name : '';
            if (!translatableProps.has(name)) return;
            const value = staticClassName(node);
            if (value === null || !hasWords.test(value)) return;
            context.report({ node, messageId: 'prop', data: { prop: name } });
          },
        };
      },
    },
    /**
     * THE SILENT HALF OF A CLOSED SCALE — plan §9.1.
     *
     * `tailwind.config.ts` REPLACES the spacing scale rather than extending it,
     * so `p-5` is not a utility. Tailwind does not warn about that; it emits
     * nothing, and the element renders with no padding at all. This rule is
     * what turns that silence into a build failure.
     *
     * The numbers below are the plan's eight values — 4 · 8 · 12 · 16 · 24 ·
     * 32 · 48 · 64 px — and they must stay identical to `spacing` in the
     * Tailwind config. Two lists that can disagree are one list too many, and
     * the symptom of disagreement is either a false failure or a missing one.
     */
    'spacing-scale-only': {
      meta: {
        type: 'problem',
        messages: {
          offScale:
            'Spacing utility "{{utility}}" is off the token scale (1 2 3 4 6 8 12 16). ' +
            'Tailwind emits nothing for it, so the element renders with no spacing at all.',
        },
      },
      create(context) {
        const allowed = new Set(['0', 'px', '1', '2', '3', '4', '6', '8', '12', '16']);
        /*
         * `w`, `h` and `size` are in the list because Tailwind's width and
         * height scales are BUILT FROM `spacing` — closing spacing closes them
         * too, and `h-5` is exactly as silent as `p-5`. Named layout tokens
         * (`w-sidebar`, `h-panel`) are non-numeric and never match.
         *
         * The `(?!\/)` is what keeps `w-1/2` legal: fractions come from
         * Tailwind's own width scale, not from spacing, and flagging them would
         * make the rule wrong in the one direction nobody forgives.
         */
        const spacingUtility =
          /\b(?:-)?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|scroll-m|scroll-p|w|h|size)-([0-9]+(?:\.[0-9]+)?|px)\b(?!\/)/g;

        return {
          JSXAttribute(node) {
            if (node.name.name !== 'className') return;
            const value = staticClassName(node);
            if (!value) return;

            for (const match of value.matchAll(spacingUtility)) {
              if (allowed.has(match[2])) continue;
              context.report({ node, messageId: 'offScale', data: { utility: match[0] } });
            }
          },
        };
      },
    },
    'semantic-tailwind-only': {
      meta: {
        type: 'problem',
        messages: {
          arbitraryValue: 'Use a named design token instead of an arbitrary Tailwind value.',
          brandLiteral: 'Use semantic brand tokens instead of a purple/orange utility.',
        },
      },
      create(context) {
        return {
          JSXAttribute(node) {
            if (node.name.name !== 'className') return;
            const value = staticClassName(node);
            if (!value) return;

            if (/[a-z-]+-\[[^\]]+\]/.test(value)) {
              context.report({ node, messageId: 'arbitraryValue' });
            }
            if (/(?:purple|orange)-\d{2,3}/.test(value)) {
              context.report({ node, messageId: 'brandLiteral' });
            }
          },
        };
      },
    },
  },
};

const config = [
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/features/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**'],
    plugins: {
      architecture: architecturePlugin,
    },
    rules: {
      'architecture/no-cross-feature-imports': 'error',
      'architecture/semantic-tailwind-only': 'error',
      'architecture/spacing-scale-only': 'error',
      'architecture/no-literal-jsx-text': 'error',
    },
  },
  {
    ignores: ['.next/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
];

export default config;
