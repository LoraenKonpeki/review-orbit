import postgres, { type Sql } from 'postgres';

export type Database = Sql;

export function createDatabase(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error('DATABASE_URL is required. Start docker compose or set DATABASE_URL.');
  return postgres(url, { max: 10, idle_timeout: 20 });
}

export async function migrate(sql: Database) {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('openai', 'github', 'gitlab')),
      name text NOT NULL,
      base_url text,
      encrypted_secret jsonb NOT NULL,
      model text,
      input_cny_per_million numeric(12,4) NOT NULL DEFAULT 0 CHECK (input_cny_per_million >= 0),
      output_cny_per_million numeric(12,4) NOT NULL DEFAULT 0 CHECK (output_cny_per_million >= 0),
      is_enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(kind, name)
    );
    CREATE TABLE IF NOT EXISTS review_policies (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      budget_cents integer NOT NULL DEFAULT 1000 CHECK (budget_cents > 0),
      budget_cny numeric(12,4) NOT NULL DEFAULT 0 CHECK (budget_cny >= 0),
      primary_model text NOT NULL DEFAULT 'gpt-4.1-mini',
      fallback_model text NOT NULL DEFAULT 'gpt-4.1-nano',
      max_files integer NOT NULL DEFAULT 120,
      max_diff_lines integer NOT NULL DEFAULT 12000,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO review_policies (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS tool_configs (
      tool_id text PRIMARY KEY,
      is_enabled boolean NOT NULL DEFAULT true,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_url text NOT NULL,
      provider text NOT NULL,
      repository text,
      change_number text,
      title text,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
      current_step text NOT NULL DEFAULT 'queued',
      output_mode text NOT NULL DEFAULT 'report' CHECK (output_mode IN ('report','publish')),
      budget_cents integer NOT NULL,
      budget_cny numeric(12,4) NOT NULL DEFAULT 0,
      spent_microusd bigint NOT NULL DEFAULT 0,
      spent_microcny bigint NOT NULL DEFAULT 0,
      input_snapshot jsonb,
      summary text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS review_steps (
      review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      step_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
      attempt integer NOT NULL DEFAULT 0,
      output jsonb,
      started_at timestamptz,
      completed_at timestamptz,
      PRIMARY KEY (review_id, step_key)
    );
    CREATE TABLE IF NOT EXISTS review_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      fingerprint text NOT NULL,
      path text NOT NULL,
      line integer,
      body text NOT NULL,
      confidence text NOT NULL CHECK (confidence IN ('high','advisory')),
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      trace_id uuid NOT NULL,
      external_comment_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(review_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS review_traces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      comment_id uuid,
      stage text NOT NULL,
      tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
      raw_diff text,
      raw_diff_ciphertext jsonb,
      sanitized_prompt text,
      model_response text,
      model text,
      input_tokens integer,
      output_tokens integer,
      cost_microusd bigint NOT NULL DEFAULT 0,
      cost_microcny bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS review_comments_review_id_idx ON review_comments(review_id);
    CREATE INDEX IF NOT EXISTS review_traces_review_id_idx ON review_traces(review_id);
  `);
  await sql`ALTER TABLE review_traces ADD COLUMN IF NOT EXISTS raw_diff_ciphertext jsonb`;
  await sql`ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS input_cny_per_million numeric(12,4) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS output_cny_per_million numeric(12,4) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE review_policies ADD COLUMN IF NOT EXISTS budget_cny numeric(12,4) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS budget_cny numeric(12,4) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS spent_microcny bigint NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE review_traces ADD COLUMN IF NOT EXISTS cost_microcny bigint NOT NULL DEFAULT 0`;
  // Earlier versions double-serialized credential payloads. Convert only JSON strings that contain an object.
  await sql`UPDATE provider_configs SET encrypted_secret = (encrypted_secret #>> '{}')::jsonb WHERE jsonb_typeof(encrypted_secret) = 'string' AND left(encrypted_secret #>> '{}', 1) = '{'`;
}
