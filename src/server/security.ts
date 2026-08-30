const secretPatterns: Array<[string, RegExp]> = [
  ['GitHub 令牌', /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['GitLab 令牌', /(?:glpat-[A-Za-z0-9_-]{20,})/g],
  ['OpenAI 密钥', /(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,})/g],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['AWS 密钥', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
  ['凭证赋值', /(?:(?:password|secret|token|api[_-]?key)\s*[:=]\s*["']?)[^\s"']{8,}/gi]
];

export type Redaction = { kind: string; count: number };
export function redactSecrets(value: string): { text: string; redactions: Redaction[] } {
  let text = value;
  const redactions: Redaction[] = [];
  for (const [kind, pattern] of secretPatterns) {
    let count = 0;
    text = text.replace(pattern, (match) => {
      count += 1;
      return `[REDACTED:${kind.toUpperCase().replaceAll(' ', '_')}:${match.length}]`;
    });
    if (count) redactions.push({ kind, count });
  }
  return { text, redactions };
}

export function assertSupportedChangeUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 GitHub PR 或 GitLab MR 链接。'); }
  if (url.protocol !== 'https:' || !['github.com', 'gitlab.com'].includes(url.hostname)) {
    throw new Error('仅支持 github.com 和 gitlab.com 的 HTTPS 评审链接。');
  }
  return url;
}
