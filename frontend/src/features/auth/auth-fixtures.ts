export type AccountRole = 'student' | 'parent';

export type PreviewState =
  | 'idle'
  | 'loading'
  | 'error'
  | 'rate-limited'
  | 'dependency-error'
  | 'success';

export function parseAccountRole(value: string | string[] | undefined): AccountRole {
  return value === 'parent' ? 'parent' : 'student';
}

export function parsePreviewState(value: string | string[] | undefined): PreviewState {
  switch (value) {
    case 'loading':
    case 'error':
    case 'rate-limited':
    case 'dependency-error':
    case 'success':
      return value;
    default:
      return 'idle';
  }
}
