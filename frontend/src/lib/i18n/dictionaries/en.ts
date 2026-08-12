/**
 * ===========================================================================
 * THE ENGLISH DICTIONARY — the SHAPE every other language must satisfy.
 *
 * `hi.ts` is typed as `typeof en`, so a missing Hindi key is a COMPILE ERROR
 * rather than a runtime fallback nobody notices. Plan §8 asks for a fallback
 * with a development warning, and that still exists for dynamic keys — but the
 * common case (a translator forgets a key) is caught by `npm run typecheck`
 * before it can ship.
 *
 * KEYS ARE NAMESPACED BY FEATURE, per §8: `practice.results.title`. Flat keys
 * collide the moment two screens both want `title`, and the collision is
 * silent.
 *
 * WHAT IS NEVER TRANSLATED (§8): CBSE, XP, NCERT, Bloom's, and subject names
 * as the syllabus writes them. Those are proper nouns in both languages, and
 * translating them makes a student search for something the syllabus does not
 * call that.
 * ===========================================================================
 */

export const en = {
  common: {
    brand: 'Alfanumrik',
    /*
     * The wordmark is rendered in two coloured halves, so it needs two keys.
     * NEITHER IS TRANSLATED — it is a brand name, and the split is visual.
     */
    brandPrefix: 'Alfa',
    brandSuffix: 'numrik',
    loading: 'Loading page',
    preview: 'Preview',
    sampleData: 'Sample data',
    languageLabel: 'Language',
    english: 'English',
    hindi: 'हिन्दी',
  },

  offline: 'You are offline. Your work will not be saved until the connection returns.',

  home: {
    eyebrow: 'Choose your learning space',
    title: 'Welcome to Alfanumrik',
    description: 'Select how you want to continue.',
    accountPrompt: 'New here?',
    accountAction: 'Create an account',
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
  },

  notFound: {
    eyebrow: '404',
    title: 'That page is not ready yet',
    description: 'Return to the role selection and choose another path.',
    action: 'Back to role selection',
  },

  error: {
    eyebrow: 'Page error',
    title: 'Something interrupted this page',
    description: 'Try loading this section again. Check your entries before continuing.',
    action: 'Try again',
  },

  session: {
    checking: 'Checking your account',
    noAccessTitle: 'This space is not available for your account',
    noAccessDescription: 'Sign in with the account that has access, or return to the start.',
    noAccessAction: 'Back to sign in',
  },

  shell: {
    previewTitle: 'Preview',
    previewNote: 'Sample information is shown while the product services are being connected.',
    studentRole: 'Student preview',
    parentRole: 'Parent preview',
    navLearn: 'Learn',
    navProgress: 'Progress',
    navPractice: 'Practice',
    navOverview: 'Overview',
    navChild: 'Child',
    navUpdates: 'Updates',
  },

  auth: {
    loginEyebrow: 'Welcome back',
    loginTitle: 'Sign in to continue',
    loginTitleStudent: 'Sign in to continue as a student',
    loginTitleParent: 'Sign in to continue as a parent',
    loginDescription: 'Use the account details connected to your learning space.',
    signupEyebrow: 'Join Alfanumrik',
    signupTitle: 'Create your account',
    signupDescription: 'Start with the essentials. Learning preferences come next.',
    verifyEyebrow: 'One quick check',
    verifyTitle: 'Verify your email',
    verifyDescription: 'Enter the six-digit code sent to your email address.',
    forgotEyebrow: 'Account recovery',
    forgotTitle: 'Reset your password',
    forgotDescription: 'Enter your email and we will send password reset instructions.',
    resetEyebrow: 'Account recovery',
    resetTitle: 'Choose a new password',
    resetDescription: 'Use at least eight characters and keep your password private.',

    identifierLabel: 'Email or mobile number',
    emailLabel: 'Email address',
    passwordLabel: 'Password',
    newPasswordLabel: 'New password',
    confirmPasswordLabel: 'Confirm password',
    confirmNewPasswordLabel: 'Confirm new password',
    nameLabel: 'Full name',
    codeLabel: 'Six-digit verification code',
    accountTypeLabel: 'Account type',
    rememberLabel: 'Remember me',
    forgotLink: 'Forgot password?',
    termsLabel: 'I agree to the Terms and Conditions and Privacy Policy.',

    loginAction: 'Sign in',
    signupAction: 'Create account',
    verifyAction: 'Verify email',
    forgotAction: 'Send reset link',
    resetAction: 'Save new password',
    waitAction: 'Please wait…',
    resendAction: 'Resend code',

    passwordMismatch: 'Passwords must match.',
    previewComplete: 'Preview complete. Backend integration is not connected yet.',
    resendComplete: 'Preview complete. A new verification code would be requested here.',

    changeRole: 'Change role',
    footerNewHere: 'New here?',
    footerCreate: 'Create an account',
    footerHaveAccount: 'Already have an account?',
    footerSignIn: 'Sign in',

    previewLoading: 'Preview: the request is taking longer than usual.',
    previewError: 'Preview: review your details and try again.',
    previewRateLimited: 'Preview: too many attempts. Please wait before trying again.',
    previewDependency: 'Preview: this service is temporarily unavailable.',
    previewSuccess: 'Preview: your request was accepted.',
  },

  onboarding: {
    studentEyebrow: 'Set up your learning',
    studentTitle: 'Make learning yours',
    studentDescription: 'Tell us where you are studying so practice matches your class.',
    parentEyebrow: 'Set up your account',
    parentTitle: 'Connect with your child',
    parentDescription: 'Add the details we need to link your account safely.',

    displayNameLabel: 'Display name',
    gradeLabel: 'Grade',
    gradePlaceholder: 'Choose your grade',
    languageLabel: 'Preferred language',
    subjectsLabel: 'Subjects to begin with',
    gradeOption: 'Grade {grade}',
    parentNameLabel: 'Your name',
    consentLabel: 'I confirm that I am the parent or legal guardian responsible for this child.',
    linkCodeLabel: 'Child invitation code',
    linkCodeHint: 'Your child generates this code in their account.',
    relationshipLabel: 'Your relationship',
    action: 'Save and continue',
    previewComplete: 'Preview complete. Your answers are not saved yet.',
  },

  student: {
    eyebrow: 'Student dashboard',
    greeting: 'Good afternoon, {name}',
    intro: 'Your next activity is ready. Pick up where you left off or review your recent learning evidence.',
    seeNext: 'See next activity',
    reviewProgress: 'Review my progress',
    nextUpEyebrow: 'Next up',
    nextUpTitle: 'Fractions in everyday life',
    nextUpDescription: 'A short practice set using recipes and sharing examples.',
    previewOnly: 'Preview only',
    weekEyebrow: 'This week',
    weekTitle: 'Four learning days',
    weekDescription:
      'A steady rhythm matters more than a perfect streak. Nice work returning regularly.',
    weekProgressLabel: '{done} of {total} learning days completed',
    progressTitle: 'How your learning is developing',
  },

  parent: {
    eyebrow: 'Parent dashboard',
    greeting: 'Welcome back, {name}',
    intro: 'See a calm, evidence-based summary of recent learning without ranking or comparison.',
    updatesEyebrow: 'Recent updates',
    updatesTitle: 'Learning activity',
  },

  progress: {
    eyebrow: 'Learning evidence',
    sampleLabel: 'Sample progress',
  },

  childSummary: {
    eyebrow: 'Your child',
    recentActivityLabel: 'Recent activity',
    latestEvidenceLabel: 'Latest evidence',
    focusAreaLabel: 'Where to focus next',
    visibilityNote: 'Your child can see everything shown on this page.',
  },
};

/**
 * NO `as const`, deliberately. It would make every value a LITERAL type, and
 * `hi.ts` — typed as `Dictionary` — would then have to contain the same
 * English strings to compile. Widened to `string`, the type still enforces the
 * SHAPE, which is the property that matters: a missing Hindi key fails the
 * build, and a Hindi value that happens to differ is the entire point.
 */
export type Dictionary = typeof en;
