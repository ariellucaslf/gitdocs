import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { mainRouter } from './routes/index.js';
import { sendSuccess, sendError } from './utils/response.js';

const app: Express = express();

// Middlewares
app.use(cors());

// JSON parser with rawBody capture for webhook signature verification
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Healthcheck Route
app.get('/health', (_req: Request, res: Response) => {
  return sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'gitdocs-backend',
  });
});

// Centralized API Routes
app.use('/api', mainRouter);

// 404 Handler
app.use((_req: Request, res: Response) => {
  return sendError(res, 'Route not found', 404);
});

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('💥 Unhandled Exception:', err);
  return sendError(res, 'Internal Server Error', 500);
});

export { app };
