import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

describe('GET /health', () => {
  it('returns status ok and service identifier', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data).toMatchObject({
      status: 'ok',
      service: 'gitdocs-backend',
    });
    expect(res.body.data).toHaveProperty('timestamp');
  });
});
