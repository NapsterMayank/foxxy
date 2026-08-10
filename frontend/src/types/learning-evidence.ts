export const learningEvidenceLabels = [
  'Not assessed yet',
  'Needs another session',
  'Developing',
  'Strong evidence',
] as const;

export type LearningEvidence = (typeof learningEvidenceLabels)[number];
