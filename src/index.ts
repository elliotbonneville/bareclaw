import { spawn } from 'child_process';
import express from 'express';
import { loadConfig } from './config.js';
import { ProcessManager } from './core/process-manager.js';
import { createHttpAdapter } from './adapters/http.js';
import { createTelegramAdapter } from './adapters/telegram.js';

const config = loadConfig();
const processManager = new ProcessManager(config);

// Self-restart: shut down everything, re-exec the same process
function restart() {
  console.log('[bareclaw] restarting...');
  processManager.shutdown();
  server.close(() => {
    const child = spawn(process.argv[0]!, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.unref();
    process.exit(0);
  });
  // If server.close hangs, force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

// HTTP
const app = express();
app.use(express.json());
app.use(createHttpAdapter(config, processManager, restart));

const server = app.listen(config.port, () => {
  console.log(`[bareclaw] HTTP listening on :${config.port}`);
  if (config.httpToken) {
    console.log(`[bareclaw] HTTP auth enabled (Bearer token)`);
  } else {
    console.log(`[bareclaw] HTTP auth disabled (no BARECLAW_HTTP_TOKEN)`);
  }
});

// Telegram (optional)
if (config.telegramToken) {
  const bot = createTelegramAdapter(config, processManager);
  bot.launch();
  console.log(`[bareclaw] Telegram bot started (${config.allowedUsers.length} allowed user(s))`);
} else {
  console.log(`[bareclaw] Telegram disabled (no BARECLAW_TELEGRAM_TOKEN)`);
}

// Graceful shutdown
function shutdown() {
  console.log('\n[bareclaw] shutting down...');
  processManager.shutdown();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', restart);

// Prevent crashes from unhandled errors
process.on('unhandledRejection', (err) => {
  console.error(`[bareclaw] unhandled rejection: ${err instanceof Error ? err.message : err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[bareclaw] uncaught exception: ${err.message}`);
});
