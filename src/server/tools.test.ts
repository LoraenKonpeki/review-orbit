import { describe, expect, it } from 'vitest';
import { getTool, toolManifests } from './tools.js';

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
});
