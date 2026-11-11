import { logSafeError } from './utils/logger.js';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { mainRouter } from './routes/index.js';
import { sendSuccess, sendError } from './utils/response.js';
import { prisma } from './config/prisma.js';
import { env } from './config/env.js';

const app: Express = express();

// Middlewares
app.use(
  cors({
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : '*',
    credentials: true,
  })
);

// JSON parser with explicit size limit (5MB) and rawBody capture for webhook signature verification
app.use(
  express.json({
    limit: '5mb',
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Healthcheck Routes (ADR 0001, V24)
app.get('/health', (_req: Request, res: Response) => {
  return sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'gitdocs-backend',
  });
});

app.get('/health/liveness', (_req: Request, res: Response) => {
  return sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'gitdocs-backend',
  });
});

app.get('/health/readiness', async (_req: Request, res: Response) => {
  try {
    // Validate live database connectivity
    await prisma.$queryRaw`SELECT 1`;

    return sendSuccess(res, {
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
      service: 'gitdocs-backend',
    });
  } catch {
    return res.status(503).json({
      success: false,
      status: 'not_ready',
      database: 'disconnected',
      error: 'Database unavailable',
      timestamp: new Date().toISOString(),
    });
  }
});

// Centralized API Routes
app.use('/api', mainRouter);

// 404 Handler
app.use((_req: Request, res: Response) => {
  return sendError(res, 'Route not found', 404);
});

// Global Error Handler (handles payload limits, JSON syntax errors, and uncaught exceptions)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    return sendError(res, 'Payload too large', 413);
  }

  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    return sendError(res, 'Malformed JSON payload', 400);
  }

  logSafeError('💥 Unhandled Exception:', err);
  return sendError(res, 'Internal Server Error', 500);
});

export { app };
