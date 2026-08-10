import { createContainer } from './app/container';
import { buildModules } from './app/routes';
import { createServer } from './app/server';
import { createShutdownController, type ShutdownController } from './app/shutdown';
import { config } from './platform/config/index';

/**
 * Process entry point.
 *
 * Importing `platform/config` validates the environment. If a required
 * variable is missing the process has already exited by the time this line
 * runs — fail at boot, not at 2am on the one code path that reads it.
 */
async function main(): Promise<void> {
  const container = createContainer(config);
  const modules = buildModules(container);

  // The cycle: the server needs to know whether a shutdown has begun, and the
  // shutdown controller needs the server in order to drain it. Reading the
  // controller through a closure breaks it, and keeps `createServer` free of
  // any knowledge of signals.
  //
  // Before the controller exists the answer is "not shutting down", which is
  // true — nothing can have signalled a server that is not yet listening.
  const deferredController: { current: ShutdownController | undefined } = { current: undefined };

  const app = await createServer(container, {
    modules,
    isShuttingDown: () => deferredController.current?.isShuttingDown() ?? false,
  });

  const controller = createShutdownController({
    app,
    logger: container.logger,
    closeResources: () => container.shutdown(),
    drainTimeoutMs: config.shutdown.drainTimeoutMs,
  });

  deferredController.current = controller;

  // Installed before `listen`, so a SIGTERM arriving during startup drains
  // cleanly instead of killing the process mid-boot.
  controller.listen();

  await app.listen({ port: config.server.port, host: config.server.host });
  container.logger.info(
    {
      port: config.server.port,
      host: config.server.host,
      appUrl: config.urls.app,
      apiUrl: config.urls.api,
      pools: config.db.pools,
    },
    'server listening',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal startup error:\n${message}\n`);
  process.exit(1);
});
