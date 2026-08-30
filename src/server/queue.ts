import { PgBoss } from 'pg-boss';
import type { Database } from './db.js';
import { createReviewWorkflow } from './workflow.js';
import type { CredentialLookup } from './providers.js';

const queueName = 'review.execute';
export type ReviewQueue = { enqueue(reviewId: string, sourceUrl: string, outputMode: 'report' | 'publish'): Promise<void>; stop(): Promise<void> };

export async function createReviewQueue(db: Database, credentials: CredentialLookup, openai: () => Promise<{ token: string; model?: string; baseUrl?: string; inputCnyPerMillion: number; outputCnyPerMillion: number } | undefined>): Promise<ReviewQueue> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const workflow = await createReviewWorkflow({ db, credentials, openai });
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  await boss.start();
  await boss.createQueue(queueName);
  await boss.work(queueName, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { reviewId: string; sourceUrl: string; outputMode: 'report' | 'publish' };
      await workflow.execute(data.reviewId, data.sourceUrl, data.outputMode);
    }
  });
  return {
    async enqueue(reviewId, sourceUrl, outputMode) {
      await boss.send(queueName, { reviewId, sourceUrl, outputMode }, { singletonKey: reviewId, retryLimit: 3, retryBackoff: true, expireInSeconds: 900 });
    },
    async stop() { await boss.stop(); }
  };
}
