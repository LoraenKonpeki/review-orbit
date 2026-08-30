import type { Database } from './db.js';
import type { ProviderKind } from '../shared/types.js';

export type PublicProvider = { id: string; kind: ProviderKind; name: string; baseUrl?: string; model?: string; inputCnyPerMillion: number; outputCnyPerMillion: number; isEnabled: boolean; isDefault: boolean; hasSecret: boolean; createdAt: string; updatedAt: string };

export function createSettingsRepository(db: Database) {
  return {
    async listProviders(): Promise<PublicProvider[]> {
      const rows = await db`SELECT id, kind, name, base_url, model, input_cny_per_million, output_cny_per_million, is_enabled, is_default, secret, encrypted_secret, created_at, updated_at FROM provider_configs ORDER BY kind, name`;
      return rows.map((row) => ({ id: String(row.id), kind: row.kind as ProviderKind, name: row.name, baseUrl: row.base_url || undefined, model: row.model || undefined, inputCnyPerMillion: Number(row.input_cny_per_million), outputCnyPerMillion: Number(row.output_cny_per_million), isEnabled: row.is_enabled, isDefault: row.is_default, hasSecret: Boolean(row.secret || row.encrypted_secret), createdAt: row.created_at, updatedAt: row.updated_at }));
    },
    async upsertProvider(input: { kind: ProviderKind; name: string; secret: string; baseUrl?: string; model?: string; inputCnyPerMillion?: number; outputCnyPerMillion?: number; isEnabled: boolean }) {
      await db`
        INSERT INTO provider_configs (kind, name, base_url, secret, model, input_cny_per_million, output_cny_per_million, is_enabled)
        VALUES (${input.kind}, ${input.name}, ${input.baseUrl || null}, ${input.secret}, ${input.model || null}, ${input.inputCnyPerMillion ?? 0}, ${input.outputCnyPerMillion ?? 0}, ${input.isEnabled})
        ON CONFLICT (kind, name) DO UPDATE SET base_url = EXCLUDED.base_url, secret = EXCLUDED.secret, encrypted_secret = null, model = EXCLUDED.model, input_cny_per_million = EXCLUDED.input_cny_per_million, output_cny_per_million = EXCLUDED.output_cny_per_million, is_enabled = EXCLUDED.is_enabled, updated_at = now()
      `;
      await db`UPDATE provider_configs candidate SET is_default = true WHERE candidate.kind = ${input.kind} AND candidate.name = ${input.name} AND candidate.is_enabled AND NOT EXISTS (SELECT 1 FROM provider_configs selected WHERE selected.kind = ${input.kind} AND selected.is_default)`;
    },
    async setProviderEnabled(id: string, isEnabled: boolean) {
      await db.begin(async (tx) => {
        const rows = await tx`SELECT kind, is_default FROM provider_configs WHERE id = ${id}`;
        if (!rows.length) return;
        await tx`UPDATE provider_configs SET is_enabled = ${isEnabled}, is_default = CASE WHEN ${isEnabled} THEN is_default ELSE false END, updated_at = now() WHERE id = ${id}`;
        if (!isEnabled && rows[0].is_default) await tx`UPDATE provider_configs candidate SET is_default = true WHERE candidate.id = (SELECT id FROM provider_configs fallback WHERE fallback.kind = ${rows[0].kind} AND fallback.is_enabled ORDER BY fallback.updated_at DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM provider_configs selected WHERE selected.kind = ${rows[0].kind} AND selected.is_default)`;
      });
    },
    async setDefaultProvider(id: string) {
      await db.begin(async (tx) => {
        const rows = await tx`SELECT kind FROM provider_configs WHERE id = ${id}`;
        if (!rows.length) throw new Error('服务商配置不存在');
        const kind = rows[0].kind as ProviderKind;
        await tx`UPDATE provider_configs SET is_default = false WHERE kind = ${kind}`;
        await tx`UPDATE provider_configs SET is_default = true, is_enabled = true, updated_at = now() WHERE id = ${id}`;
      });
    },
    async deleteProvider(id: string) {
      await db.begin(async (tx) => {
        const rows = await tx`SELECT kind, is_default FROM provider_configs WHERE id = ${id}`;
        if (!rows.length) throw new Error('服务商配置不存在');
        const kind = rows[0].kind as ProviderKind;
        await tx`DELETE FROM provider_configs WHERE id = ${id}`;
        if (rows[0].is_default) await tx`UPDATE provider_configs candidate SET is_default = true WHERE candidate.id = (SELECT id FROM provider_configs fallback WHERE fallback.kind = ${kind} AND fallback.is_enabled ORDER BY fallback.updated_at DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM provider_configs selected WHERE selected.kind = ${kind} AND selected.is_default)`;
      });
    },
    async updateProvider(id: string, input: { kind: ProviderKind; name: string; secret?: string; baseUrl?: string; model?: string; inputCnyPerMillion?: number; outputCnyPerMillion?: number; isEnabled: boolean }) {
      if (input.secret) {
        await db`UPDATE provider_configs SET kind = ${input.kind}, name = ${input.name}, base_url = ${input.baseUrl || null}, secret = ${input.secret}, encrypted_secret = null, model = ${input.model || null}, input_cny_per_million = ${input.inputCnyPerMillion ?? 0}, output_cny_per_million = ${input.outputCnyPerMillion ?? 0}, is_enabled = ${input.isEnabled}, updated_at = now() WHERE id = ${id}`;
      } else {
        await db`UPDATE provider_configs SET kind = ${input.kind}, name = ${input.name}, base_url = ${input.baseUrl || null}, model = ${input.model || null}, input_cny_per_million = ${input.inputCnyPerMillion ?? 0}, output_cny_per_million = ${input.outputCnyPerMillion ?? 0}, is_enabled = ${input.isEnabled}, updated_at = now() WHERE id = ${id}`;
      }
    },
    async credential(kind: ProviderKind) {
      const rows = await db`SELECT secret, base_url, model, input_cny_per_million, output_cny_per_million FROM provider_configs WHERE kind = ${kind} AND is_enabled = true ORDER BY is_default DESC, updated_at DESC LIMIT 1`;
      if (!rows.length) return undefined;
      if (!rows[0].secret) {
        const label: Record<ProviderKind, string> = { github: 'GitHub Token', gitlab: 'GitLab Token', openai: 'LLM API Key' };
        throw new Error(`已保存的 ${label[kind]} 仍是旧版密文。请在连接设置中重新输入凭证后重试任务。`);
      }
      return { token: rows[0].secret, baseUrl: rows[0].base_url || undefined, model: rows[0].model || undefined, inputCnyPerMillion: Number(rows[0].input_cny_per_million), outputCnyPerMillion: Number(rows[0].output_cny_per_million) };
    },
    async policy() {
      const rows = await db`SELECT budget_cny, primary_model, fallback_model, max_files, max_diff_lines, updated_at FROM review_policies WHERE id = true`;
      return rows[0];
    },
    async updatePolicy(input: { budgetCny: number; fallbackModel: string; maxFiles: number; maxDiffLines: number }) {
      await db`UPDATE review_policies SET budget_cny = ${input.budgetCny}, fallback_model = ${input.fallbackModel}, max_files = ${input.maxFiles}, max_diff_lines = ${input.maxDiffLines}, updated_at = now() WHERE id = true`;
    }
  };
}
