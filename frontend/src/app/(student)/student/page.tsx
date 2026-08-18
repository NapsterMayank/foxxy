import type { Metadata } from 'next';
import { DashboardScreen } from '@/features/dashboard/dashboard-screen';

export const metadata: Metadata = {
  title: 'Student dashboard',
};

/**
 * Open item 51 — the last fixture screen in the product.
 *
 * The banner is INSIDE the screen here, unlike `/student/progress` where the
 * route owns it: this one greets the student by name, and the name is read in
 * the browser. A server component cannot know it — the session cookie belongs
 * to `api.<domain>` and never reaches the Next server.
 */
export default function StudentDashboardPage() {
  return <DashboardScreen />;
}
