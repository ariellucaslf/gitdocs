import crypto from 'node:crypto';
import { queueService } from './queue.service.js';
import { jobProcessorService } from './processor.service.js';

export class BackgroundWorker {
  private workerId: string;
  private isRunning = false;
  private pollIntervalMs: number;

  constructor(pollIntervalMs: number = 3000) {
    this.workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.pollIntervalMs = pollIntervalMs;
  }

  async processNextJob(): Promise<boolean> {
    const run = await queueService.reserveNextJob(this.workerId);
    if (!run) {
      return false;
    }

    console.log(`👷 [Worker ${this.workerId}] Reserved run ${run.id} for PR #${run.prNumber}`);
    await jobProcessorService.processRun(run, this.workerId);
    return true;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(`🚀 [Worker ${this.workerId}] Started background worker loop.`);

    while (this.isRunning) {
      try {
        const handled = await this.processNextJob();
        if (!handled) {
          // No job available, wait poll interval
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (err) {
        console.error(`💥 [Worker ${this.workerId}] Loop error:`, err);
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  stop(): void {
    console.log(`🛑 [Worker ${this.workerId}] Stopping worker...`);
    this.isRunning = false;
  }
}

// Allow standalone execution: tsx src/worker/worker.ts
if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  const worker = new BackgroundWorker();

  const shutdown = () => {
    worker.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  worker.start().catch((err) => {
    console.error('Fatal worker error:', err);
    process.exit(1);
  });
}
