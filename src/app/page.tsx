export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold">Cortex API</h1>
      <p className="text-sm text-neutral-500">
        This is the backend service — REST API, agent orchestration, and Trigger.dev tasks.
        The chat UI lives in the frontend app.
      </p>
      <p className="text-xs text-neutral-400">
        <a href="/api/health" className="underline">
          /api/health
        </a>
      </p>
    </main>
  );
}
