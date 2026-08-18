import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChapterWalkthrough } from '@/features/learn/chapter-walkthrough';
import { SUBJECTS } from '@/lib/api/generated/constants/curriculum';

export const metadata: Metadata = {
  title: 'Chapter',
};

/**
 * One chapter, read one idea at a time.
 *
 * BOTH SEGMENTS ARE VALIDATED HERE. A path segment is user input exactly as a
 * query string is: an unknown subject is a 404 rather than a request the API
 * would refuse, and the chapter id is checked for shape so a malformed one does
 * not become a 400 rendered as a broken screen.
 */
export default async function ChapterPage({
  params,
}: {
  params: Promise<{ subject: string; chapter: string }>;
}) {
  const { chapter, subject } = await params;

  if (!(SUBJECTS as readonly string[]).includes(subject)) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(chapter)) notFound();

  return (
    <div className="space-y-6 sm:space-y-8">
      <ChapterWalkthrough chapterId={chapter} subject={subject} />
    </div>
  );
}
