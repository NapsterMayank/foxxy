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
    navLearn2: 'Study',
    navFoxy: 'Ask Foxy',
    navBilling: 'Plan',

    /*
     * The header identity, which is a LINK to the profile and not a sixth
     * navigation item. Mobile navigation is already five columns wide, and
     * open item 47 records the last time a sixth was refused on a guess about
     * who the screen belongs to. A profile is reached from your own name.
     */
    identityAction: 'View and edit your profile',
    identityUnknown: 'Your account',
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
    // The six-digit code this used to describe was never an endpoint. Backend
    // verification is `GET /auth/verify?token=` — the link in the email.
    verifyDescription: 'Open the link we emailed you. This page finishes the check.',
    forgotEyebrow: 'Account recovery',
    forgotTitle: 'Reset your password',
    forgotDescription: 'Enter your email and we will send password reset instructions.',
    resetEyebrow: 'Account recovery',
    resetTitle: 'Choose a new password',
    resetDescription: 'Use at least 10 characters and keep your password private.',

    emailLabel: 'Email address',
    passwordLabel: 'Password',
    newPasswordLabel: 'New password',
    confirmPasswordLabel: 'Confirm password',
    confirmNewPasswordLabel: 'Confirm new password',
    accountTypeLabel: 'Account type',
    forgotLink: 'Forgot password?',
    termsLabel: 'I agree to the Terms and Conditions and Privacy Policy.',

    loginAction: 'Sign in',
    signupAction: 'Create account',
    forgotAction: 'Send reset link',
    resetAction: 'Save new password',
    waitAction: 'Please wait…',
    resendAction: 'Send the link again',

    passwordMismatch: 'Passwords must match.',

    /*
     * FIELD-LEVEL MESSAGES. Chosen from the Zod issue by `authFieldMessage`,
     * never taken from `issue.message` — those sentences live in the backend's
     * contract and are English-only, so rendering them would put English in
     * front of a Hindi reader through a variable the lint rule cannot see.
     */
    errorRequired: 'Fill this in to continue.',
    errorEmailInvalid: 'Enter a valid email address.',
    errorPasswordTooShort: 'Use at least 10 characters.',
    errorPasswordTooLong: 'Use at most 200 characters.',
    errorTermsRequired: 'Accept the Terms and the Privacy Policy to create an account.',

    /* FORM-LEVEL MESSAGES, one per §5.6 treatment the auth screens can meet. */
    errorInvalidCredentials: 'That email and password do not match an account.',
    errorRateLimited: 'Too many attempts. Wait a moment and try again.',
    errorRateLimitedSeconds: 'Too many attempts. Try again in {seconds} seconds.',
    errorDegraded: 'Something we rely on is unavailable right now. Try again shortly.',
    errorBlocked: 'That request was refused. Reload the page and try again.',
    errorLinkInvalid: 'This link has expired or has already been used.',
    errorGeneric: 'Something went wrong. Try again.',

    /* VERIFICATION — a link, not a code. */
    verifyMissingToken: 'This link is incomplete. Open the full link from your email.',
    verifyPending: 'Checking your link…',
    verifySuccess: 'Your email is verified. Sign in to continue.',
    verifyNeeded: 'Your email address is not verified yet.',
    resendEmailHint: 'We will send the verification link to this address again.',
    resendSent: 'If that address needs verifying, a new link is on its way.',

    forgotSent: 'If that address has an account, reset instructions are on their way.',
    resetSuccess: 'Your new password is saved. Sign in with it now.',
    signupSuccess: 'Account created. Check your email for the verification link.',

    changeRole: 'Change role',
    footerNewHere: 'New here?',
    footerCreate: 'Create an account',
    footerHaveAccount: 'Already have an account?',
    footerSignIn: 'Sign in',

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
    consentLabel: 'I confirm that I am the parent or legal guardian responsible for this child.',
    linkCodeLabel: 'Child invitation code',
    linkCodeHint: 'Your child generates this code in their account.',
    action: 'Save and continue',

    subjectOption: {
      mathematics: 'Mathematics',
      science: 'Science',
    },

    errorSubjectsRequired: 'Choose at least one subject.',
    errorGradeRequired: 'Choose your grade.',
    errorDisplayNameRequired: 'Enter the name you want to be called.',
    errorLinkCodeInvalid: 'A link code is 6 characters.',
    errorLinkCodeUnknown: 'That code is not valid. Ask your child for a fresh one.',
    errorConsentRequired: 'Confirm you are the parent or guardian to continue.',

    studentSaved: 'Your profile is set up. Practice is ready when you are.',
    linkPending: 'Request sent. Your child approves it from their account before you see anything.',
  },

  /**
   * The student dashboard.
   *
   * WHAT IS NOT HERE IS THE POINT. `nextUpTitle` used to read "Fractions in
   * everyday life" and `weekTitle` "Four learning days" — sentences written
   * into the dictionary about a chapter nobody chose and a week nobody had.
   * Every line below is either furniture or a slot filled from this student's
   * own rows.
   *
   * `greeting` LOST ITS TIME OF DAY. "Good afternoon" was rendered at every
   * hour to every user; a greeting that is wrong two thirds of the day is
   * worse than one that never claims to know.
   */
  student: {
    eyebrow: 'Student dashboard',
    greeting: 'Hello, {name}',
    greetingUnknown: 'Hello',
    intro: 'Your next practice and what your recent sessions show.',
    reviewProgress: 'Review my progress',

    nextUpEyebrow: 'Next up',
    nextUpChapter: 'Chapter {number} · {title}',
    nextUpQuestions: '{count} questions',
    startPractice: 'Start practice',
    missionEmptyTitle: 'Nothing to practise yet',
    missionEmptyDescription: 'Once your subjects have chapters, your next practice appears here.',

    continueEyebrow: 'Where you left off',
    continueNone: 'You have not finished a practice session yet.',
    continueChapter: '{title} · practised {date}',

    loading: 'Loading your dashboard',
    errorTitle: 'Your dashboard could not load',
    retryAction: 'Try again',
  },

  parent: {
    eyebrow: 'Parent dashboard',
    title: 'Your child’s learning',
    intro: 'See a calm, evidence-based summary of recent learning without ranking or comparison.',
    updatesEyebrow: 'Recent updates',
    updatesTitle: 'Learning activity',
  },

  progress: {
    eyebrow: 'Learning evidence',
    sampleLabel: 'Sample progress',
  },

  /**
   * The four evidence labels — plan §9.1.
   *
   * A CLOSED SET FROM THE BACKEND (`EVIDENCE_LABELS`), worded here. They used
   * to BE English strings in the type system, so a Hindi reader saw English on
   * their own progress; the code now comes from the wire and the words from
   * here.
   *
   * NONE OF THEM IS A NUMBER, and none of them can become one: §9.1 forbids
   * mastery percentages, and `EvidenceLabel` has no prop that could carry one.
   */
  evidence: {
    strong: 'Strong evidence',
    developing: 'Developing',
    needsAnotherSession: 'Needs another session',
    notAssessed: 'Not assessed yet',
  },

  /**
   * Foxy — build-order step 9.
   *
   * `Foxy` IS NOT TRANSLATED anywhere below. It is the tutor's name, and §8's
   * rule about proper nouns applies to it exactly as it applies to NCERT: a
   * child who learns to press "Foxy" in English must find the same word in
   * Hindi.
   *
   * THE SIX ACTION LABELS ARE ABSENT FROM THIS FILE, deliberately. They arrive
   * from `GET /foxy/capabilities` already bilingual, because the label and the
   * prompt it triggers live side by side on the server — see the note on
   * `FOXY_ACTIONS`. A copy here would be a seventh place for them to drift, and
   * the drift would make a button do something other than what it says.
   */
  foxy: {
    eyebrow: 'Ask Foxy',
    title: 'Foxy, your textbook tutor',
    description: 'Foxy answers from your NCERT textbook and shows you where each answer came from.',

    startTitle: 'What would you like to do?',
    startDescription: 'Pick a subject and how you want to work. You can start again at any time.',
    modeLabel: 'How would you like to work?',
    modeOption: {
      doubt: 'Ask me anything',
      explain: 'Walk me through a topic',
      practice: 'Quiz me',
    },
    subjectLabel: 'Subject',
    startAction: 'Start',
    startAgainAction: 'Start a new conversation',

    transcriptLabel: 'Conversation with Foxy',
    youLabel: 'You',
    foxyLabel: 'Foxy',
    streamingLabel: 'Foxy is answering',
    /*
     * An abstention is a SUCCESSFUL ANSWER and this wording has to carry that.
     * "Foxy could not answer" reads as a fault; "not in this textbook" is the
     * true statement, and it is the one that builds the trust the abstention
     * exists for.
     */
    abstainedLabel: 'Not found in your textbook',
    citationsTitle: 'From your textbook',
    citationChapter: 'Chapter {number}: {title}',
    citationUnknownChapter: 'Your textbook',
    truncatedNotice: 'This answer was longer than Foxy can show. Ask again for a shorter one.',

    composerLabel: 'Your question',
    composerPlaceholder: 'Type your question',
    composerRemaining: '{remaining} characters left',
    sendAction: 'Send',
    stopAction: 'Stop',
    retryAction: 'Try again',

    actionsTitle: 'Or ask Foxy to',

    emptyTitle: 'Ask your first question',
    emptyDescription: 'Type a question, or pick one of the buttons below to get started.',
    loadingTranscript: 'Loading your conversation',

    usageRemaining: '{remaining} of {limit} messages left today',
    usageExhausted: 'You have used all of today’s messages. Foxy will be back tomorrow.',

    errorTitle: 'Foxy could not answer',
    errorGeneric: 'Something interrupted the answer. Try asking again.',
    errorPartial: 'The answer stopped part way through. What arrived is still above.',
    errorRateLimited: 'That was quick. Wait a moment before asking again.',
    errorRateLimitedSeconds: 'That was quick. Try again in {seconds} seconds.',
    errorDegraded: 'Foxy is busy right now. Try again in a moment.',
    errorBlocked: 'That question could not be sent. Try rewording it.',
    errorNotFound: 'This conversation is no longer available. Start a new one.',
    errorStartFailed: 'The conversation could not be started. Try again.',
    errorCapabilities: 'Foxy could not load. Try again.',
  },

  /**
   * Practice — build-order step 10.
   *
   * NO PERCENTAGE ANYWHERE. `SubmissionResult` carries `scorePercent` and this
   * screen renders `correctCount` of `questionCount` instead: a session score
   * and a mastery percentage look identical to a child, and §9.1 forbids the
   * second. "4 of 6" is a fact about six questions; "67%" is a verdict.
   */
  practice: {
    eyebrow: 'Practice',
    title: 'Today’s practice',
    description: 'A short set of questions, chosen from what you have been learning.',

    missionEyebrow: 'Chosen for you',
    missionNoneTitle: 'Nothing is waiting for you yet',
    missionNoneDescription: 'Pick up a chapter from your subjects and practice will appear here.',
    missionQuestionCount: '{count} questions',
    startAction: 'Start practice',
    startAgainAction: 'Practise something else',

    questionProgress: 'Question {current} of {total}',
    optionsLabel: 'Choose one answer',
    answerAction: 'Check my answer',
    nextAction: 'Next question',
    finishAction: 'Finish and see my result',
    loadingSession: 'Getting your questions ready',

    feedbackCorrect: 'That is right.',
    /*
     * NOT "wrong", and not red — §9.1. The sentence names what happens next,
     * because the explanation underneath it is the point of the moment.
     */
    feedbackIncorrect: 'Not this time. Here is why.',
    correctAnswerLabel: 'The answer is:',
    explanationTitle: 'Why',

    summaryTitle: 'Session complete',
    summaryScore: '{correct} of {total} correct',
    summaryXp: '{xp} XP',
    summaryXpWithheld: '{withheld} XP was not added — today’s cap is full.',
    summaryEvidenceTitle: 'What this shows',
    summaryNextReview: 'This chapter comes back around on {date}.',
    summaryDoneAction: 'Back to my dashboard',

    /*
     * AN INVALID ATTEMPT IS NOT AN ACCUSATION. XP is withheld and the sentence
     * says what to do differently; nothing here calls a child a cheat, and the
     * backend's reason CODE is never rendered.
     */
    invalidTitle: 'This attempt did not count',
    invalidTooFast:
      'The answers came in faster than they can be read. Take your time and try the chapter again.',
    invalidSameAnswer:
      'Every question got the same option. Try again when you can give each one a look.',
    invalidGeneric: 'Something about this attempt could not be counted. Try the chapter again.',

    errorTitle: 'Practice could not load',
    errorGeneric: 'Something went wrong. Try again.',
    errorStartFailed: 'The practice session could not be started. Try again.',
    errorAnswerFailed: 'That answer was not recorded. Try again.',
    errorConflict: 'That was already recorded. Carry on from where the screen is now.',
    errorAnswerConflict: 'This question already has an answer, and answers cannot be changed.',
    errorSubmitConflict: 'This session was already finished.',
    errorSessionGone: 'This practice session is no longer available. Start a new one.',
    errorRateLimited: 'That was quick. Wait a moment and try again.',
    errorRateLimitedSeconds: 'That was quick. Try again in {seconds} seconds.',
    errorDegraded: 'Something we rely on is unavailable right now. Try again shortly.',
    retryAction: 'Try again',
  },

  /**
   * Progress — build-order step 11.
   *
   * XP IS A NUMBER AND EVIDENCE IS A WORD, and that split is the whole screen.
   * XP counts what was done; evidence describes what it shows. §9.1 allows the
   * first and forbids the second from ever becoming a percentage.
   */
  progressScreen: {
    eyebrow: 'Your progress',
    title: 'What your practice shows',
    description:
      'Evidence from your own sessions. No scores out of ten, and nothing compared with anybody else.',

    totalXpLabel: 'XP earned',
    xpTodayLabel: 'XP today',
    sessionsLabel: 'Sessions finished',

    chaptersTitle: 'Chapter by chapter',
    attemptsLabel: '{count} sessions',
    lastPractisedLabel: 'Last practised {date}',
    neverPractisedLabel: 'Not practised yet',
    nextReviewLabel: 'Review due {date}',

    historyTitle: 'Recent sessions',
    historyScore: '{xp} XP',
    historyPending: 'Not finished',
    historyInvalid: 'Did not count',

    emptyTitle: 'No practice yet',
    emptyDescription: 'Finish one practice session and your evidence will appear here.',
    loading: 'Loading your progress',
    errorTitle: 'Progress could not load',
    retryAction: 'Try again',
  },

  /**
   * The profile screen — `GET`/`PATCH /me/profile`.
   *
   * THE BOARD IS NOT HERE BECAUSE IT IS NOT EDITABLE. The contract omits it
   * from the PATCH on purpose: changing a board re-points the entire syllabus
   * a student sees, which is a migration rather than a profile edit. A label
   * for a field nobody can change is a label somebody will later attach an
   * input to.
   *
   * `languageHint` exists because there are TWO languages on this product and
   * this screen only sets one of them. The switch in the header changes what
   * THIS INTERFACE is written in, on this device, and is stored in a cookie.
   * The field below tells the server which language to answer in — Foxy's
   * replies, a parent's digest, the sentences the backend composes. Somebody
   * who changes one and expects the other to follow has been misled by us, so
   * the screen says which is which.
   */
  profileScreen: {
    eyebrow: 'Your account',
    title: 'Your profile',
    description: 'The name we call you, the class you are studying, and the language we answer in.',

    displayNameLabel: 'Display name',
    displayNameHint: 'This is the name Foxy and your parent see.',
    gradeLabel: 'Grade',
    gradeOption: 'Grade {grade}',
    languageLabel: 'Language we answer in',
    languageHint: 'Foxy and your reports use this. To change the language of this screen, use the switch at the top.',
    boardLabel: 'Board',
    boardNote: 'Your board is set when your account is created and cannot be changed here.',

    action: 'Save changes',
    unchangedHint: 'Change something to save.',
    saved: 'Your profile is updated.',

    errorDisplayNameRequired: 'Enter the name you want to be called.',
    errorGradeRequired: 'Choose your grade.',
    errorLanguageRequired: 'Choose a language.',
    errorGeneric: 'Your profile could not be saved. Try again.',
    errorConflict: 'Your profile changed somewhere else. Reload and try again.',

    loading: 'Loading your profile',
    errorTitle: 'Your profile could not load',
    retryAction: 'Try again',
    missingTitle: 'No profile yet',
    missingDescription: 'Finish setting up your account and your profile will appear here.',
    missingAction: 'Set up my account',
  },

  /**
   * The parent dashboard — build-order step 12.
   *
   * ALMOST NO PROSE LIVES HERE, AND THAT IS THE DESIGN. The summary, the trend
   * line, the digest, the suggested action, the disclosure and the consent
   * notice all arrive from the server in BOTH languages — `bilingualTextSchema`
   * requires a non-empty `hi` — because they are sentences about one particular
   * child, derived from that child's own rows. A template here would replace a
   * true specific sentence with a generic one.
   *
   * What is worded here is the furniture: headings, the four trend words, the
   * consent vocabulary, and the errors.
   */
  parentDashboard: {
    childLabel: '{name} · Grade {grade}',
    childPickerLabel: 'Choose which child to view',

    snapshotTitle: 'This week',
    trendMore: 'More practice than last week',
    trendSame: 'About the same as last week',
    /* `less` is a fact about a week, never a verdict on a child. */
    trendLess: 'Less practice than last week',
    trendFirstWeek: 'The first week, so there is nothing to compare with yet',

    digestTitle: 'What this week showed',
    digestActionTitle: 'One thing that would help',
    digestMisconception: 'Reference: {code}',
    digestCounts: '{days} days · {sessions} sessions · {questions} questions',
    digestPendingTitle: 'This week’s summary is not written yet',
    digestPendingDescription: 'Summaries are prepared once a week. This one will appear here.',

    transcriptTitle: 'Conversations with Foxy',
    transcriptChild: 'Your child',
    transcriptFoxy: 'Foxy',
    transcriptReadOnly: 'Read only',
    transcriptEmptyTitle: 'No conversations yet',
    transcriptEmptyDescription: 'Anything your child asks Foxy will appear here.',
    /*
     * A DIFFERENT SENTENCE FROM "no conversations yet", deliberately. The
     * contract keeps `not_yet_available` apart from an empty list so a parent
     * learns which — telling them their child has never asked anything, when
     * the truth is that nobody can see it yet, is a false statement about
     * their child.
     */
    transcriptUnavailableTitle: 'Conversations are not available yet',
    transcriptUnavailableDescription:
      'This part of the product is not ready. It is not that your child has asked nothing.',

    visibilityChildTold: 'Your child knows you can read these conversations.',
    visibilityChildNotTold: 'Your child has not been told that you can read these conversations.',

    consentTitle: 'Your access',
    consentViewSnapshot: 'The weekly snapshot',
    consentViewDigest: 'The weekly summary',
    consentViewTranscript: 'Conversations with Foxy',
    consentChildInformed: 'Your child has been told about this access.',
    consentChildNotInformed: 'Your child has not been told about this access.',
    consentRevokeAction: 'Withdraw my access',
    consentRevokeTitle: 'Withdraw your access?',
    /* What WILL happen, in the parent's words — never "are you sure?". */
    consentRevokeDescription:
      'You will stop seeing this child’s snapshot, summary and conversations. Only your child can give access again, with a new invitation code.',
    consentRevokeConfirm: 'Withdraw access',
    consentRevokeCancel: 'Keep my access',

    noChildrenTitle: 'No child is linked yet',
    noChildrenDescription: 'Ask your child for an invitation code from their account to get started.',
    pendingTitle: 'Waiting for your child to approve',
    pendingDescription:
      'Your request has been sent. Nothing is shown here until your child approves it from their own account.',

    loading: 'Loading',
    errorTitle: 'This could not be loaded',
    panelErrorDescription: 'This section could not be loaded. The rest of the page is unaffected.',
    errorGeneric: 'Something went wrong. Try again.',
    /* A state, not a fault. Nothing to press: a 403 will not become a 200. */
    errorNoAccess: 'You no longer have access to this child’s learning. Only your child can give it again.',
    errorNotFound: 'This is no longer available.',
    errorBlocked: 'That request was refused. Reload the page and try again.',
    errorRateLimited: 'Too many requests. Wait a moment and try again.',
    errorRateLimitedSeconds: 'Too many requests. Try again in {seconds} seconds.',
    errorDegraded: 'Something we rely on is unavailable right now. Try again shortly.',
    retryAction: 'Try again',
  },

  /**
   * Billing — build-order step 13.
   *
   * NO PRICE, NO CURRENCY AND NO PLAN NAME LIVES HERE. Every figure comes from
   * `GET /billing/plans`, which reads the same table the checkout path reads,
   * so the number quoted and the number charged cannot drift. A hard-coded
   * "₹299" is not a UI bug — it is advertising one price and charging another.
   */
  billing: {
    eyebrow: 'Subscription',
    title: 'Your plan',
    description: 'What your account includes, and what changing it would cost.',

    currentTitle: 'Right now',
    planFree: 'Free plan',
    planPaid: 'Paid plan',
    currentPlanBadge: 'Your plan',
    currentPlanNote: 'This is the plan you are on.',
    paidBySchool: 'Your school pays for this account. There is nothing for you to buy or cancel.',

    statusActive: 'Active',
    /* `pending` grants nothing until the provider confirms payment. */
    statusPending: 'Waiting for payment',
    statusPastDue: 'Payment needs attention',
    statusCancelled: 'Cancelled',
    statusExpired: 'Expired',

    renewsOn: 'Renews on {date}.',
    accessUntil: 'You keep access until {date}.',
    cancelledNote: 'This plan will not renew.',

    plansTitle: 'Plans',
    perMonth: 'per month',
    perYear: 'per year',
    perDays: 'every {days} days',
    chooseAction: 'Choose this plan',

    featurePracticeBasic: 'Daily practice',
    featurePracticeUnlimited: 'Unlimited practice',
    featureFoxyBasic: 'Ask Foxy',
    featureFoxyUnlimited: 'Unlimited questions for Foxy',
    featureParentDigest: 'Weekly summary for a parent',

    cancelAction: 'Cancel my plan',
    cancelTitle: 'Cancel your plan?',
    /* What WILL happen — including the part people most fear losing. */
    cancelDescription:
      'Your plan will not renew. You keep everything you have now until {date}, and nothing is charged after that.',
    cancelConfirm: 'Cancel the plan',
    cancelKeep: 'Keep my plan',

    loading: 'Loading your plan',
    errorTitle: 'Your plan could not be loaded',
    errorPlansTitle: 'Plans could not be loaded',
    errorGeneric: 'Something went wrong. Try again.',
    /*
     * A 409 means they ALREADY HAVE IT. "Try again" would send somebody back
     * into a payment they have already made.
     */
    errorAlreadySubscribed: 'You already have an active plan. Reload this page to see it.',
    errorPlanUnavailable: 'That plan is no longer available. Reload this page for the current plans.',
    errorNoSubscription: 'There is no plan to change.',
    errorCheckoutFailed: 'The payment page could not be opened. Nothing has been charged.',
    errorCheckoutUnavailable: 'The payment page could not be opened. Nothing has been charged.',
    errorProviderUnavailable: 'The payment service is unavailable right now. Try again shortly.',
    errorBlocked: 'That request was refused. Reload the page and try again.',
    errorRateLimited: 'Too many attempts. Wait a moment and try again.',
    errorRateLimitedSeconds: 'Too many attempts. Try again in {seconds} seconds.',
    retryAction: 'Try again',
  },

  /**
   * The study browser — subject → chapter → concept.
   *
   * The chapter TITLES and every concept's words come from the corpus, not from
   * here. This section is only the furniture around them.
   */
  learn: {
    eyebrow: 'Study',
    title: 'Your subjects',
    description: 'Read a chapter one idea at a time, then practise it.',

    subjectsLabel: 'Choose a subject',
    pickSubject: 'Pick a subject to see its chapters.',
    chaptersTitle: 'Chapters',
    noChapters: 'There are no chapters for your grade in this subject yet.',

    chapterNumber: 'Chapter {number}',
    backToChapters: '← All chapters',
    conceptProgress: 'Idea {current} of {total}',
    keyFormula: 'Formula',
    example: 'Example',
    commonMistakes: 'Watch out for',

    previousConcept: 'Back',
    nextConcept: 'Next idea',
    practiceThisChapter: 'Practise this',
    practiceInstead: 'Practise this chapter',
    askFoxy: 'Ask Foxy about this',

    /*
     * Ten of the 137 chapters have no concepts. That is content missing rather
     * than a chapter missing, and the wording has to say so — a student told
     * "not found" would reasonably conclude the app is broken.
     */
    noConceptsTitle: 'This chapter has no reading yet',
    noConceptsDescription: 'The questions for it are ready, so you can still practise it.',

    loading: 'Loading',
    errorTitle: 'This could not be loaded',
    errorDescription: 'Something went wrong. Try again.',
    retryAction: 'Try again',
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
