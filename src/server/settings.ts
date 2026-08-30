import type { Database } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import type { ProviderKind } from '../shared/types.js';

type StoredCiphertext = { iv: string; tag: string; ciphertext: string };
export type PublicProvider = { id: string; kind: ProviderKind; name: string; baseUrl?: string; model?: string; inputCnyPerMillion: number; outputCnyPerMillion: number; isEnabled: boolean; hasSecret: boolean; createdAt: string; updatedAt: string };

export function createSettingsRepository(db: Database) {
  return {
    async listProviders(): Promise<PublicProvider[]> {
      const rows = await db`SELECT id, kind, name, base_url, model, input_cny_per_million, output_cny_per_million, is_enabled, created_at, updated_at FROM provider_configs ORDER BY kind, name`;
      return rows.map((row) => ({ id: String(row.id), kind: row.kind as ProviderKind, name: row.name, baseUrl: row.base_url || undefined, model: row.model || undefined, inputCnyPerMillion: Number(row.input_cny_per_million), outputCnyPerMillion: Number(row.output_cny_per_million), isEnabled: row.is_enabled, hasSecret: true, createdAt: row.created_at, updatedAt: row.updated_at }));
    },
    async upsertProvider(input: { kind: ProviderKind; name: string; secret: string; baseUrl?: string; model?: string; inputCnyPerMillion?: number; outputCnyPerMillion?: number; isEnabled: boolean }) {
      const secret = db.json(encrypt(input.secret));
      await db`
        INSERT INTO provider_configs (kind, name, base_url, encrypted_secret, model, input_cny_per_million, output_cny_per_million, is_enabled)
        VALUES (${input.kind}, ${input.name}, ${input.baseUrl || null}, ${secret}, ${input.model || null}, ${input.inputCnyPerMillion ?? 0}, ${input.outputCnyPerMillion ?? 0}, ${input.isEnabled})
        ON CONFLICT (kind, name) DO UPDATE SET base_url = EXCLUDED.base_url, encrypted_secret = EXCLUDED.encrypted_secret, model = EXCLUDED.model, input_cny_per_million = EXCLUDED.input_cny_per_million, output_cny_per_million = EXCLUDED.output_cny_per_million, is_enabled = EXCLUDED.is_enabled, updated_at = now()
      `;
    },
    async setProviderEnabled(id: string, isEnabled: boolean) {
      await db`UPDATE provider_configs SET is_enabled = ${isEnabled}, updated_at = now() WHERE id = ${id}`;
    },
    async credential(kind: ProviderKind) {
      const rows = await db`SELECT encrypted_secret, base_url, model, input_cny_per_million, output_cny_per_million FROM provider_configs WHERE kind = ${kind} AND is_enabled = true ORDER BY updated_at DESC LIMIT 1`;
      if (!rows.length) return undefined;
      const cipher = rows[0].encrypted_secret as StoredCiphertext;
      return { token: decrypt(cipher), baseUrl: rows[0].base_url || undefined, model: rows[0].model || undefined, inputCnyPerMillion: Number(rows[0].input_cny_per_million), outputCnyPerMillion: Number(rows[0].output_cny_per_million) };
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
