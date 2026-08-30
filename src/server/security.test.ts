import { describe, expect, it } from 'vitest';
import { assertSupportedChangeUrl, redactSecrets } from './security.js';

describe('secret redaction', () => {
  it('masks provider tokens before model prompting', () => {
    const result = redactSecrets('const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";\nconst key = "sk-proj_abcdefghijklmnopqrstuvwxyz1234";');
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).not.toContain('sk-proj_abcdefghijklmnopqrstuvwxyz1234');
    expect(result.redactions.length).toBeGreaterThan(0);
  });
  it('only permits canonical public Git providers', () => {
    expect(() => assertSupportedChangeUrl('https://github.com/acme/app/pull/12')).not.toThrow();
    expect(() => assertSupportedChangeUrl('http://github.com/acme/app/pull/12')).toThrow();
    expect(() => assertSupportedChangeUrl('https://attacker.example/pull/12')).toThrow();
  });
});
