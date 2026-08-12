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
  /** The app-shell offline notice. Plain, and never alarming. */
  offline: 'You are offline. Your work will not be saved until the connection returns.',
  /**
   * The session gate. Deliberately says nothing about WHY access was refused —
   * §5.6's rule for a 403 on a read is "a no-access state carrying no detail
   * about what exists", and a message naming the required role is that detail.
   */
  session: {
    checking: 'Checking your account',
    noAccess: {
      title: 'This space is not available for your account',
      description: 'Sign in with the account that has access, or return to the start.',
      action: 'Back to sign in',
    },
  },
} as const;
