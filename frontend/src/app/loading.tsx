export default function LoadingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-shell items-center px-4 py-16 sm:px-6 lg:px-8">
      <section className="w-full animate-pulse" aria-busy="true" aria-label="Loading page">
        <div className="mx-auto h-4 w-1/3 rounded-full bg-line" />
        <div className="mx-auto mt-4 h-bar w-full max-w-prose rounded-md bg-line" />
        <div className="mx-auto mt-4 h-4 w-2/3 rounded-md bg-line" />
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="h-panel rounded-card bg-line" />
          <div className="h-panel rounded-card bg-line" />
        </div>
      </section>
    </main>
  );
}
