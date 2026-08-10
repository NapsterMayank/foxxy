import type { Grade } from '../../../src/shared/constants/curriculum';

/**
 * The shape of a golden question.
 *
 * `grade` and `subject` are REQUIRED because retrieval hard-filters by them:
 * a question without them is not a question this system can be asked, and a
 * calibration set that omitted them would be measuring an unfiltered pipeline
 * that does not exist.
 */
export interface GoldenQuestion {
  /** Exactly what a student would type. */
  readonly query: string;
  readonly grade: Grade;
  readonly subject: 'mathematics' | 'science';
  /**
   * For an in-corpus question: the chapter it should land in, so a human
   * reading the harness output can tell "scored low" from "scored low AND
   * retrieved the wrong chapter".
   *
   * For an off-syllabus question: why it is off-syllabus.
   */
  readonly note: string;
}
