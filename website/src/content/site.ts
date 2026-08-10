export const primaryNavigation = [
  { href: '/', label: 'Home' },
  { href: '/features', label: 'Features' },
  { href: '/for-parents', label: 'For Parents' },
  { href: '/for-schools', label: 'For Schools' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About Us' },
] as const;

export const highlights = [
  { value: '1M+', label: 'learners supported' },
  { value: '50K+', label: 'questions solved daily' },
  { value: '10K+', label: 'schools reached' },
  { value: '4.8/5', label: 'parent rating' },
] as const;

export const features = [
  {
    icon: 'spark',
    title: 'AI Tutor Foxy',
    description: 'Step-by-step explanations that help learners understand the method, not just copy an answer.',
  },
  {
    icon: 'book',
    title: 'CBSE-aligned content',
    description: 'Lessons and questions organised around the syllabus students already follow at school.',
  },
  {
    icon: 'practice',
    title: 'Smart practice',
    description: 'Adaptive quizzes and worksheets focus practice where it can make the biggest difference.',
  },
  {
    icon: 'chart',
    title: 'Visible progress',
    description: 'Clear evidence shows what is secure, what is developing, and where to practise next.',
  },
  {
    icon: 'exam',
    title: 'Exams and mock tests',
    description: 'Real exam-style experiences build confidence before important school assessments.',
  },
  {
    icon: 'language',
    title: 'English and Hindi',
    description: 'Learners can study in the language that makes difficult ideas easier to understand.',
  },
] as const;

export const audiencePages = {
  parents: {
    eyebrow: 'For parents',
    title: 'Stay connected. Support better.',
    intro: 'Follow learning without hovering over every lesson. Alfanumrik turns activity into clear, useful signals for your family.',
    points: [
      'See recent practice and learning evidence',
      'Understand strengths and areas needing support',
      'Manage subscriptions and family preferences',
      'Receive important progress updates',
    ],
    cards: [
      ['Clarity, not surveillance', 'Reports focus on learning evidence and helpful next steps.'],
      ['One calm overview', 'See linked learners without juggling separate accounts.'],
      ['Built around trust', 'Private by default, with clear family controls.'],
    ],
  },
  schools: {
    eyebrow: 'For schools',
    title: 'Help every classroom move forward.',
    intro: 'Give teachers useful tools, aligned practice and a clearer view of learner needs—without adding another complicated workflow.',
    points: [
      'CBSE-aligned digital learning content',
      'Class and learner progress summaries',
      'Teacher-friendly assignment workflows',
      'Scalable access for growing schools',
    ],
    cards: [
      ['Teacher-friendly', 'A focused workspace designed to support, not replace, teaching.'],
      ['School-ready', 'Clear permissions and practical reporting for real classrooms.'],
      ['Built to scale', 'Start with a class, then extend across grades and campuses.'],
    ],
  },
} as const;

export const pricingPlans = [
  {
    name: 'Monthly',
    price: '₹299',
    suffix: '/ month',
    description: 'Flexible access to all learner features.',
    features: ['AI Tutor Foxy', 'Practice and quizzes', 'Progress evidence', 'Exams and mock tests'],
    action: 'Start monthly',
    featured: false,
  },
  {
    name: 'Yearly',
    price: '₹2,499',
    suffix: '/ year',
    description: 'The best value for steady learning all year.',
    features: ['Everything in Monthly', 'Save compared with monthly', 'One simple annual renewal', 'Family progress view'],
    action: 'Choose yearly',
    featured: true,
  },
  {
    name: 'School or bulk',
    price: 'Custom',
    suffix: '',
    description: 'Plans for schools, classes and learning groups.',
    features: ['School onboarding', 'Teacher workspace', 'Learner reporting', 'Priority support'],
    action: 'Talk to our team',
    featured: false,
  },
] as const;

export const values = [
  ['Make learning explainable', 'A learner should understand why an answer works, not merely receive it.'],
  ['Respect every learner', 'Different speeds, languages and backgrounds deserve thoughtful support.'],
  ['Earn family trust', 'Privacy, transparency and honest progress signals are product requirements.'],
] as const;
