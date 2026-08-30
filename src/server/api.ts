import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './db.js';
import { decrypt } from './crypto.js';
import { assertSupportedChangeUrl } from './security.js';
import { toolManifests } from './tools.js';
import type { ReviewQueue } from './queue.js';
import { createSettingsRepository } from './settings.js';

const providerSchema = z.object({ kind: z.enum(['openai', 'github', 'gitlab']), name: z.string().min(1).max(80), secret: z.string().min(8), baseUrl: z.string().url().optional().or(z.literal('')), model: z.string().max(120).optional(), inputCnyPerMillion: z.number().min(0).max(1_000_000).optional(), outputCnyPerMillion: z.number().min(0).max(1_000_000).optional(), isEnabled: z.boolean().default(true) });
const providerUpdateSchema = providerSchema.extend({ secret: z.string().min(8).optional() });
const policySchema = z.object({ budgetCny: z.number().min(0).max(1_000_000), fallbackModel: z.string().min(1).max(120), maxFiles: z.number().int().min(1).max(500), maxDiffLines: z.number().int().min(100).max(100_000) });
const reviewSchema = z.object({ sourceUrl: z.string().url(), outputMode: z.enum(['report', 'publish']).default('report') });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues.map((item) => item.message).join(', '));
  return result.data;
}

export async function registerApi(app: FastifyInstance, db: Database, queue: ReviewQueue) {
  const settings = createSettingsRepository(db);
  for (const manifest of toolManifests()) await db`INSERT INTO tool_configs (tool_id, is_enabled) VALUES (${manifest.id}, ${manifest.defaultEnabled}) ON CONFLICT (tool_id) DO NOTHING`;

  app.get('/api/health', async () => ({ ok: true, service: 'review-orbit' }));
  app.get('/api/dashboard', async () => {
    const [stats] = await db`SELECT count(*) FILTER (WHERE status = 'running')::int AS running, count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status IN ('completed','partial'))::int AS completed, coalesce(sum(spent_microcny), 0)::bigint AS spent FROM reviews WHERE created_at >= now() - interval '30 days'`;
    const recent = await db`SELECT id, title, repository, change_number, status, current_step, budget_cny, spent_microcny, created_at FROM reviews ORDER BY created_at DESC LIMIT 6`;
    return { stats, recent };
  });

  app.get('/api/providers', async () => settings.listProviders());
  app.post('/api/providers', async (request, reply) => {
    const input = parse(providerSchema, request.body);
    await settings.upsertProvider({ ...input, baseUrl: input.baseUrl || undefined, isEnabled: input.isEnabled ?? true });
    return reply.code(201).send({ ok: true });
  });
  app.patch('/api/providers/:id', async (request) => {
    const body = parse(z.object({ isEnabled: z.boolean() }), request.body);
    await settings.setProviderEnabled((request.params as { id: string }).id, body.isEnabled);
    return { ok: true };
  });
  app.put('/api/providers/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = parse(providerUpdateSchema, request.body);
    const exists = await db`SELECT id FROM provider_configs WHERE id = ${id}`;
    if (!exists.length) return reply.code(404).send({ error: '服务商配置不存在' });
    await settings.updateProvider(id, { ...input, baseUrl: input.baseUrl || undefined, isEnabled: input.isEnabled ?? true });
    return { ok: true };
  });

  app.get('/api/policy', async () => settings.policy());
  app.put('/api/policy', async (request) => {
    await settings.updatePolicy(parse(policySchema, request.body));
    return { ok: true };
  });

  app.get('/api/tools', async () => {
    const saved = await db`SELECT tool_id, is_enabled, config, updated_at FROM tool_configs`;
    const byId = new Map(saved.map((row) => [row.tool_id, row]));
    return toolManifests().map((manifest) => ({ ...manifest, isEnabled: byId.get(manifest.id)?.is_enabled ?? manifest.defaultEnabled, config: byId.get(manifest.id)?.config ?? {} }));
  });
  app.put('/api/tools/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!toolManifests().some((tool) => tool.id === id)) return reply.code(404).send({ error: '未知工具' });
    const body = parse(z.object({ isEnabled: z.boolean(), config: z.record(z.unknown()).default({}) }), request.body);
    await db`INSERT INTO tool_configs (tool_id, is_enabled, config, updated_at) VALUES (${id}, ${body.isEnabled}, ${JSON.stringify(body.config)}::jsonb, now()) ON CONFLICT (tool_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, config = EXCLUDED.config, updated_at = now()`;
    return { ok: true };
  });

  app.get('/api/reviews', async () => db`SELECT id, source_url, provider, repository, change_number, title, status, current_step, output_mode, budget_cny, spent_microcny, summary, error, created_at, updated_at, completed_at FROM reviews ORDER BY created_at DESC LIMIT 100`);
  app.post('/api/reviews', async (request, reply) => {
    const input = parse(reviewSchema, request.body);
    const url = assertSupportedChangeUrl(input.sourceUrl);
    const policy = await settings.policy();
    const provider = url.hostname === 'github.com' ? 'github' : 'gitlab';
    const outputMode = input.outputMode ?? 'report';
    const rows = await db`INSERT INTO reviews (source_url, provider, output_mode, budget_cents, budget_cny) VALUES (${input.sourceUrl}, ${provider}, ${outputMode}, 0, ${policy.budget_cny}) RETURNING id`;
    await queue.enqueue(String(rows[0].id), input.sourceUrl, outputMode);
    return reply.code(201).send({ id: rows[0].id });
  });
  app.get('/api/reviews/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const review = await db`SELECT * FROM reviews WHERE id = ${id}`;
    if (!review.length) return reply.code(404).send({ error: '评审任务不存在' });
    const [comments, steps] = await Promise.all([
      db`SELECT id, path, line, body, confidence, evidence, trace_id, external_comment_id, created_at FROM review_comments WHERE review_id = ${id} ORDER BY created_at`,
      db`SELECT step_key, status, attempt, output, started_at, completed_at FROM review_steps WHERE review_id = ${id} ORDER BY started_at NULLS LAST`
    ]);
    return { ...review[0], comments, steps };
  });
  app.post('/api/reviews/:id/retry', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const rows = await db`SELECT source_url, output_mode, status FROM reviews WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: '评审任务不存在' });
    if (rows[0].status === 'running') return reply.code(409).send({ error: '评审任务正在执行中' });
    await queue.enqueue(id, rows[0].source_url, rows[0].output_mode);
    return { ok: true };
  });
  app.post('/api/reviews/:id/cancel', async (request) => {
    const id = (request.params as { id: string }).id;
    await db`UPDATE reviews SET status = 'cancelled', current_step = 'cancelled', updated_at = now() WHERE id = ${id} AND status IN ('queued','running')`;
    return { ok: true };
  });
  app.get('/api/reviews/:id/report.md', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const review = await db`SELECT title, repository, change_number, status, summary, created_at FROM reviews WHERE id = ${id}`;
    if (!review.length) return reply.code(404).send('评审任务不存在');
    const comments = await db`SELECT path, line, body, confidence, evidence FROM review_comments WHERE review_id = ${id} ORDER BY path, line`;
    const statusLabels: Record<string, string> = { queued: '排队中', running: '执行中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' };
    const report = [`# 代码评审：${review[0].title || review[0].repository || id}`, '', `- 状态：${statusLabels[review[0].status] || review[0].status}`, `- 来源：${review[0].repository || '等待拉取'}${review[0].change_number ? ` #${review[0].change_number}` : ''}`, `- 摘要：${review[0].summary || '执行中'}`, '', '## 评审发现', ''];
    report.push(...comments.map((comment) => `### ${comment.confidence === 'high' ? '高置信度，可直接采纳' : '仅供参考'}：\`${comment.path}${comment.line ? `:${comment.line}` : ''}\`\n\n${comment.body}\n\n证据：${(comment.evidence as Array<{ source: string }>).map((item) => item.source).join(', ')}`));
    return reply.type('text/markdown; charset=utf-8').send(report.join('\n'));
  });
  app.get('/api/traces/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const rows = await db`SELECT * FROM review_traces WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: '追踪记录不存在' });
    const trace = rows[0];
    let rawDiff: string | undefined;
    try { rawDiff = trace.raw_diff_ciphertext ? decrypt(trace.raw_diff_ciphertext) : trace.raw_diff || undefined; } catch { rawDiff = '[无法解密追踪数据]'; }
    return { id: trace.id, reviewId: trace.review_id, stage: trace.stage, toolCalls: trace.tool_calls, rawDiff, sanitizedPrompt: trace.sanitized_prompt, modelResponse: trace.model_response, model: trace.model, inputTokens: trace.input_tokens, outputTokens: trace.output_tokens, costMicrocny: trace.cost_microcny, createdAt: trace.created_at };
  });
}
