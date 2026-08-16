import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { sendSuccess } from './utils/response.js';

const app: Express = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Healthcheck Route
app.get('/health', (_req: Request, res: Response) => {
  return sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'gitdocs-backend',
  });
});

export { app };
