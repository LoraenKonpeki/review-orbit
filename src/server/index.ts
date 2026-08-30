import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createDatabase, migrate } from './db.js';
import { createSettingsRepository } from './settings.js';
import { createReviewQueue } from './queue.js';
import { registerApi } from './api.js';

const app = Fastify({ logger: process.env.NODE_ENV === 'production' });
const db = createDatabase();
await migrate(db);
const settings = createSettingsRepository(db);
const queue = await createReviewQueue(db, async (kind) => settings.credential(kind), async () => settings.credential('openai'));
await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') || true });
await registerApi(app, db, queue);

const clientDir = path.resolve('dist/client');
if (existsSync(clientDir)) {
  await app.register(fastifyStatic, { root: clientDir });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
}
app.setErrorHandler((error, _request, reply) => reply.code(400).send({ error: error instanceof Error ? error.message : '请求失败' }));
const close = async () => { await queue.stop(); await db.end({ timeout: 5 }); await app.close(); };
process.once('SIGTERM', close); process.once('SIGINT', close);
await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
