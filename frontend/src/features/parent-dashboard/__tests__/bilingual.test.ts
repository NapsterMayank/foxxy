import { describe, expect, it } from 'vitest';
import { bilingual } from '../lib/bilingual';

describe('server prose in the reader’s language', () => {
  const text = { en: 'Aarav practised on four days.', hi: 'आरव ने चार दिन अभ्यास किया।' };

  it('gives each reader their own language', () => {
    expect(bilingual(text, 'en')).toBe(text.en);
    expect(bilingual(text, 'hi')).toBe(text.hi);
  });

  /*
   * `bilingualTextSchema` puts `min(1)` on BOTH halves, so anything that
   * reached `apiRequest` has them. The fallback still earns its place: this
   * shape is rendered from fixtures, from a cache written by an older build,
   * and from whatever a future endpoint sends before its schema is tightened.
   * A blank paragraph where a parent expects a sentence about their child is a
   * worse failure than the same sentence in the wrong language.
   */
  it('falls back rather than rendering a blank paragraph', () => {
    expect(bilingual({ en: 'Only English.', hi: '' }, 'hi')).toBe('Only English.');
    expect(bilingual({ en: '   ', hi: 'केवल हिंदी।' }, 'en')).toBe('केवल हिंदी।');
  });

  it('leaves both blank alone rather than inventing text', () => {
    expect(bilingual({ en: '', hi: '' }, 'en')).toBe('');
  });
});
