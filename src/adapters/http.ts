import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { SendMessageRequest } from '../core/types.js';

export function createHttpAdapter(config: Config, processManager: ProcessManager, restart: () => void): Router {
  const router = express.Router();

  // Bearer token auth middleware
  if (config.httpToken) {
    router.use((req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      if (header !== `Bearer ${config.httpToken}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  router.post('/message', async (req, res) => {
    const { text, channel } = req.body as SendMessageRequest;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing "text" field' });
      return;
    }

    const ch = channel || 'http';
    console.log(`[http] ← ${ch}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

    try {
      const response = await processManager.send(ch, text);
      console.log(`[http] → ${ch}: ${response.duration_ms}ms`);
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[http] error on channel ${ch}: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.post('/restart', (_req, res) => {
    console.log('[http] restart requested');
    res.json({ status: 'restarting' });
    // Delay to let the response flush
    setTimeout(restart, 100);
  });

  return router;
}
