import { describe, expect, it } from 'vitest';
import { getTool, runEnabledTools, toolManifests } from './tools.js';

describe('declarative tools', () => {
  it('does not enable a repository-executing typecheck by default', () => {
    const typecheck = toolManifests().find((tool) => tool.id === 'typecheck');
    expect(typecheck?.defaultEnabled).toBe(false);
    expect(typecheck?.execution.executesRepositoryCode).toBe(false);
  });
  it('produces deterministic high-confidence findings', async () => {
    const result = await getTool('builtin-static-rules')!.run([{ path: 'src/example.ts', patch: '+ eval(input)' }]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe('high');
  });
  it('registers the default static review workflow tools', () => {
    const defaults = toolManifests().filter((tool) => tool.defaultEnabled).map((tool) => tool.id);
    expect(defaults).toEqual(expect.arrayContaining(['builtin-static-rules', 'dependency-guard', 'query-safety', 'error-handling']));
  });
  it('runs declared tools by id and preserves their execution record', async () => {
    const results = await runEnabledTools([{ path: 'package.json', patch: '+ "demo": "latest"' }], ['dependency-guard']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolId: 'dependency-guard', detail: expect.any(String) });
    expect(results[0].comments[0]).toMatchObject({ confidence: 'high', path: 'package.json' });
  });
});
