export default function LoadingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-shell items-center px-4 py-16 sm:px-6 lg:px-8">
      <section className="w-full animate-pulse" aria-busy="true" aria-label="Loading page">
        <div className="mx-auto h-4 w-32 rounded-full bg-line" />
        <div className="mx-auto mt-4 h-10 w-64 max-w-full rounded-xl bg-line" />
        <div className="mx-auto mt-4 h-5 w-80 max-w-full rounded-xl bg-line" />
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="h-80 rounded-card bg-line" />
          <div className="h-80 rounded-card bg-line" />
        </div>
      </section>
    </main>
  );
}
