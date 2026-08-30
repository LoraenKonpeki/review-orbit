import { describe, expect, it } from 'vitest';
import { encrypt } from './crypto.js';

describe('credential payload format', () => {
  it('keeps encrypted credentials as a JSON object payload', () => {
    process.env.APP_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    const payload = encrypt('example-provider-token');
    expect(Object.keys(payload).sort()).toEqual(['ciphertext', 'iv', 'tag']);
    expect(JSON.parse(JSON.stringify(payload))).toMatchObject({ iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) });
  });
});
