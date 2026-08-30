import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ChatOpenAI } from '@langchain/openai';
import type { Database } from './db.js';
import { encrypt } from './crypto.js';
import { loadChangeRequest, publishReviewReport, type CredentialLookup } from './providers.js';
import { redactSecrets } from './security.js';
import { runEnabledTools } from './tools.js';
import type { DiffFile, ReviewComment } from '../shared/types.js';

type LlmCredential = { token: string; model?: string; baseUrl?: string; inputCnyPerMillion: number; outputCnyPerMillion: number } | undefined;
type Context = { db: Database; credentials: CredentialLookup; openai: () => Promise<LlmCredential> };
type WorkflowState = {
  reviewId: string;
  sourceUrl: string;
  outputMode: 'report' | 'publish';
  files: DiffFile[];
  sanitizedFiles: DiffFile[];
  staticComments: ReviewComment[];
  modelComments: ReviewComment[];
  toolCalls: Array<{ id: string; detail: string; findings: number }>;
  allComments: ReviewComment[];
  truncated: boolean;
};

const State = Annotation.Root({
  reviewId: Annotation<string>,
  sourceUrl: Annotation<string>,
  outputMode: Annotation<'report' | 'publish'>,
  files: Annotation<DiffFile[]>({ value: (_left, right) => right, default: () => [] }),
  sanitizedFiles: Annotation<DiffFile[]>({ value: (_left, right) => right, default: () => [] }),
  staticComments: Annotation<ReviewComment[]>({ value: (_left, right) => right, default: () => [] }),
  modelComments: Annotation<ReviewComment[]>({ value: (_left, right) => right, default: () => [] }),
  toolCalls: Annotation<Array<{ id: string; detail: string; findings: number }>>({ value: (_left, right) => right, default: () => [] }),
  allComments: Annotation<ReviewComment[]>({ value: (_left, right) => right, default: () => [] }),
  truncated: Annotation<boolean>({ value: (_left, right) => right, default: () => false })
});

function asJson(value: unknown) { return JSON.stringify(value); }
async function step(db: Database, reviewId: string, key: string, output: unknown) {
  await db`
    INSERT INTO review_steps (review_id, step_key, status, attempt, started_at, completed_at, output)
    VALUES (${reviewId}, ${key}, 'completed', 1, now(), now(), ${asJson(output)}::jsonb)
    ON CONFLICT (review_id, step_key) DO UPDATE SET status = 'completed', completed_at = now(), output = EXCLUDED.output, attempt = review_steps.attempt + 1
  `;
  await db`UPDATE reviews SET current_step = ${key}, updated_at = now() WHERE id = ${reviewId}`;
}

function parseModelComments(content: string): ReviewComment[] {
  const candidate = content.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return [];
  try {
    const rows = JSON.parse(candidate) as Array<Record<string, unknown>>;
    return rows.filter((row) => typeof row.path === 'string' && typeof row.body === 'string').slice(0, 20).map((row) => ({
      path: String(row.path), line: typeof row.line === 'number' ? row.line : undefined,
      body: String(row.body), confidence: 'advisory' as const,
      evidence: [{ source: 'llm-review', detail: 'Model-generated suggestion; validate against repository context.' }]
    }));
  } catch { return []; }
}

function costMicrocny(input: number, output: number, inputCnyPerMillion: number, outputCnyPerMillion: number) {
  // 1 CNY / 百万 Token 恰好等于每个 Token 1 微元，避免浮点换算误差。
  return Math.ceil(input * inputCnyPerMillion + output * outputCnyPerMillion);
}

function makeGraph(context: Context, saver: PostgresSaver) {
  const ingest = async (state: WorkflowState) => {
    const { provider, change } = await loadChangeRequest(state.sourceUrl, context.credentials);
    const policy = await context.db`SELECT max_files, max_diff_lines FROM review_policies WHERE id = true`;
    const maxFiles = policy[0]?.max_files ?? 120;
    const maxLines = policy[0]?.max_diff_lines ?? 12_000;
    let lines = 0;
    const files = change.files.filter((file) => {
      lines += file.patch.split('\n').length;
      return lines <= maxLines;
    }).slice(0, maxFiles);
    const truncated = files.length < change.files.length;
    await context.db`UPDATE reviews SET provider = ${provider}, repository = ${change.repository}, change_number = ${change.number}, title = ${change.title}, input_snapshot = ${asJson({ ...change, files: files.map(({ patch, ...f }) => f) })}::jsonb WHERE id = ${state.reviewId}`;
    await step(context.db, state.reviewId, 'ingest', { files: files.length, truncated });
    return { files, truncated };
  };

  const redact = async (state: WorkflowState) => {
    const sanitizedFiles = state.files.map((file) => ({ ...file, patch: redactSecrets(file.patch).text }));
    const redactions = state.files.flatMap((file) => redactSecrets(file.patch).redactions);
    await step(context.db, state.reviewId, 'redact', { redactions });
    return { sanitizedFiles };
  };

  const analyze = async (state: WorkflowState) => {
    const rows = await context.db`SELECT tool_id FROM tool_configs WHERE is_enabled = true`;
    const enabled = rows.map((row) => row.tool_id);
    if (!enabled.includes('builtin-static-rules')) enabled.push('builtin-static-rules');
    const results = await runEnabledTools(state.files, enabled);
    const staticComments = results.flatMap((result) => result.comments);
    const toolCalls = results.map(({ toolId, detail, comments }) => ({ id: toolId, detail, findings: comments.length }));
    await step(context.db, state.reviewId, 'tools', { tools: toolCalls, comments: staticComments.length });
    return { staticComments, toolCalls };
  };

  const review = async (state: WorkflowState) => {
    const credential = await context.openai();
    if (!credential) {
      await step(context.db, state.reviewId, 'model_review', { skipped: '未配置已启用的 OpenAI 服务商。' });
      return { modelComments: [] };
    }
    const policy = await context.db`SELECT budget_cny, fallback_model FROM review_policies WHERE id = true`;
    const reviewRow = await context.db`SELECT spent_microcny FROM reviews WHERE id = ${state.reviewId}`;
    const budget = Math.round(Number(policy[0]?.budget_cny ?? 0) * 1_000_000);
    const spent = Number(reviewRow[0]?.spent_microcny ?? 0);
    const modelName = budget > 0 && spent > budget * 0.7 ? policy[0]?.fallback_model : credential.model;
    const prompt = `请审查以下已脱敏的 PR/MR diff。只返回 JSON 数组，每个对象格式为 {"path":string,"line":number|null,"body":string}。只报告具体的正确性、安全性或可靠性问题；不要声称绝对确定，不要复述已脱敏的内容。评审意见必须使用中文。\n\n${state.sanitizedFiles.map((file) => `文件：${file.path}\n${file.patch}`).join('\n\n').slice(0, 110_000)}`;
    const model = new ChatOpenAI({ model: modelName, apiKey: credential.token, configuration: credential.baseUrl ? { baseURL: credential.baseUrl } : undefined, temperature: 0 });
    const response = await model.invoke([{ role: 'system', content: '你是一名谨慎的代码评审工程师。只返回有效 JSON，所有评审意见使用简体中文。' }, { role: 'user', content: prompt }]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const inputTokens = response.usage_metadata?.input_tokens ?? 0;
    const outputTokens = response.usage_metadata?.output_tokens ?? 0;
    const cost = costMicrocny(inputTokens, outputTokens, credential.inputCnyPerMillion, credential.outputCnyPerMillion);
    const trace = await context.db`INSERT INTO review_traces (review_id, stage, tool_calls, raw_diff_ciphertext, sanitized_prompt, model_response, model, input_tokens, output_tokens, cost_microusd, cost_microcny) VALUES (${state.reviewId}, 'model_review', ${asJson(state.toolCalls)}::jsonb, ${asJson(encrypt(state.files.map((file) => `FILE: ${file.path}\n${file.patch}`).join('\n\n')))}::jsonb, ${prompt}, ${content}, ${modelName || null}, ${inputTokens}, ${outputTokens}, 0, ${cost}) RETURNING id`;
    await context.db`UPDATE reviews SET spent_microcny = spent_microcny + ${cost} WHERE id = ${state.reviewId}`;
    const modelComments = parseModelComments(content).map((comment) => ({ ...comment, evidence: [...comment.evidence, { source: 'trace', detail: String(trace[0].id) }] }));
    await step(context.db, state.reviewId, 'model_review', { model: modelName, inputTokens, outputTokens, cost, comments: modelComments.length });
    return { modelComments };
  };

  const finalize = async (state: WorkflowState) => {
    const allComments = [...state.staticComments, ...state.modelComments];
    for (const comment of allComments) {
      const fingerprint = `${comment.path}:${comment.line ?? 0}:${comment.body}`;
      const modelTrace = comment.evidence.find((item) => item.source === 'trace')?.detail;
      const traceId = modelTrace || String((await context.db`INSERT INTO review_traces (review_id, stage, tool_calls, raw_diff_ciphertext) VALUES (${state.reviewId}, 'comment', ${asJson(comment.evidence)}::jsonb, ${asJson(encrypt(state.files.find((file) => file.path === comment.path)?.patch ?? ''))}::jsonb) RETURNING id`)[0].id);
      const inserted = await context.db`INSERT INTO review_comments (review_id, fingerprint, path, line, body, confidence, evidence, trace_id) VALUES (${state.reviewId}, ${fingerprint}, ${comment.path}, ${comment.line ?? null}, ${comment.body}, ${comment.confidence}, ${asJson(comment.evidence)}::jsonb, ${traceId}) ON CONFLICT (review_id, fingerprint) DO NOTHING RETURNING id`;
      if (inserted.length) await context.db`UPDATE review_traces SET comment_id = ${inserted[0].id} WHERE id = ${traceId}`;
    }
    if (state.outputMode === 'publish') {
      const externalId = await publishReviewReport(state.sourceUrl, context.credentials, state.reviewId, allComments);
      await context.db`UPDATE review_comments SET external_comment_id = ${externalId} WHERE review_id = ${state.reviewId}`;
      await step(context.db, state.reviewId, 'publish', { externalCommentId: externalId });
    }
    const status = state.truncated ? 'partial' : 'completed';
    const summary = `已生成 ${allComments.length} 条评审意见${state.truncated ? '；输入已按策略限制截断。' : '。'}`;
    await context.db`UPDATE reviews SET status = ${status}, current_step = 'complete', summary = ${summary}, completed_at = now(), updated_at = now() WHERE id = ${state.reviewId}`;
    await step(context.db, state.reviewId, 'finalize', { comments: allComments.length, status });
    return { allComments };
  };

  return new StateGraph(State)
    .addNode('ingest', ingest)
    .addNode('redact', redact)
    .addNode('tools', analyze)
    .addNode('model_review', review)
    .addNode('finalize', finalize)
    .addEdge(START, 'ingest').addEdge('ingest', 'redact').addEdge('redact', 'tools').addEdge('tools', 'model_review').addEdge('model_review', 'finalize').addEdge('finalize', END)
    .compile({ checkpointer: saver });
}

export async function createReviewWorkflow(context: Context) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('LangGraph PostgreSQL checkpoint 需要配置 DATABASE_URL。');
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: 'langgraph' });
  await saver.setup();
  const graph = makeGraph(context, saver);
  return {
    async execute(reviewId: string, sourceUrl: string, outputMode: 'report' | 'publish') {
      await context.db`UPDATE reviews SET status = 'running', current_step = 'ingest', error = null, updated_at = now() WHERE id = ${reviewId}`;
      try {
        await graph.invoke({ reviewId, sourceUrl, outputMode }, { configurable: { thread_id: reviewId } });
      } catch (error) {
        await context.db`UPDATE reviews SET status = 'failed', error = ${error instanceof Error ? error.message : '未知工作流错误'}, updated_at = now() WHERE id = ${reviewId}`;
        throw error;
      }
    }
  };
}
