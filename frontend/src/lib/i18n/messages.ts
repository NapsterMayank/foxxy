export const messages = {
  brand: 'Alfanumrik',
  eyebrow: 'Choose your learning space',
  title: 'Welcome to Alfanumrik',
  description: 'Select how you want to continue.',
  student: {
    label: 'I am a student',
    description: 'Learn, practise, take tests and track your progress.',
    action: 'Continue as student',
  },
  parent: {
    label: 'I am a parent',
    description: 'Track progress, manage subscriptions and support your child.',
    action: 'Continue as parent',
  },
  accountPrompt: 'New here?',
  accountAction: 'Create an account',
  notFound: {
    title: 'That page is not ready yet',
    description: 'Return to the role selection and choose another path.',
    action: 'Back to role selection',
  },
  error: {
    title: 'Something interrupted this page',
    description: 'Try loading this section again. Check your entries before continuing.',
    action: 'Try again',
  },
} as const;
