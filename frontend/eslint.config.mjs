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
    },
  },
  {
    ignores: ['.next/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
];

export default config;
