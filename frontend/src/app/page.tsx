import Link from 'next/link';
import { ParentIllustration, StudentIllustration } from '@/components/ui/role-illustrations';
import { RoleCard } from '@/components/ui/role-card';
import { messages } from '@/lib/i18n/messages';

export default function RoleSelectionPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-shell flex-col px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <header className="flex items-center justify-between" aria-label={messages.brand}>
        <span className="text-lg font-extrabold tracking-tight text-ink">
          <span className="text-logo">Alfa</span>numrik
        </span>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center py-12 sm:py-16">
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">{messages.eyebrow}</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            {messages.title}
          </h1>
          <p className="mt-4 text-base leading-7 text-muted sm:text-lg">{messages.description}</p>
        </div>

        <div className="mt-8 grid gap-6 sm:mt-12 sm:grid-cols-2">
          <RoleCard
            action={messages.student.action}
            description={messages.student.description}
            href="/login?role=student"
            illustration={<StudentIllustration />}
            label={messages.student.label}
            theme="student"
          />
          <RoleCard
            action={messages.parent.action}
            description={messages.parent.description}
            href="/login?role=parent"
            illustration={<ParentIllustration />}
            label={messages.parent.label}
            theme="parent"
          />
        </div>

        <p className="mt-8 text-center text-sm text-muted">
          {messages.accountPrompt}{' '}
          <Link className="font-semibold text-brand underline-offset-4 hover:underline" href="/signup">
            {messages.accountAction}
          </Link>
        </p>
      </section>
    </main>
  );
}
