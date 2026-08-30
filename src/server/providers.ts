import { assertSupportedChangeUrl } from './security.js';
import type { ChangeRequest, DiffFile, ProviderKind, ReviewComment } from '../shared/types.js';

export type CredentialLookup = (kind: 'github' | 'gitlab') => Promise<{ token: string; baseUrl?: string } | undefined>;

function githubUrl(url: URL) {
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error('GitHub 链接格式应为 github.com/组织/仓库/pull/编号。');
  return { owner: match[1], repo: match[2], number: match[3] };
}

function gitlabUrl(url: URL) {
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match) throw new Error('GitLab 链接应以 /-/merge_requests/编号 结尾。');
  return { project: match[1], number: match[2] };
}

async function request(url: string, token: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Git 代码平台返回 ${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
}

async function gitlabRequest(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitLab 返回 ${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
}

export async function loadChangeRequest(sourceUrl: string, credentials: CredentialLookup): Promise<{ provider: ProviderKind; change: ChangeRequest }> {
  const url = assertSupportedChangeUrl(sourceUrl);
  if (url.hostname === 'github.com') {
    const credential = await credentials('github');
    if (!credential) throw new Error('未配置已启用的 GitHub 凭证。');
    const { owner, repo, number } = githubUrl(url);
    const api = credential.baseUrl || 'https://api.github.com';
    const pull = await request(`${api}/repos/${owner}/${repo}/pulls/${number}`, credential.token, { 'X-GitHub-Api-Version': '2022-11-28' });
    const files = await request(`${api}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, credential.token) as any[];
    return { provider: 'github', change: {
      title: pull.title, repository: `${owner}/${repo}`, number,
      headSha: pull.head?.sha,
      files: files.filter((f) => f.patch).map((f): DiffFile => ({ path: f.filename, patch: f.patch, additions: f.additions, deletions: f.deletions }))
    }};
  }
  const credential = await credentials('gitlab');
  if (!credential) throw new Error('未配置已启用的 GitLab 凭证。');
  const { project, number } = gitlabUrl(url);
  const api = credential.baseUrl || 'https://gitlab.com/api/v4';
  const prefix = api.replace(/\/$/, '');
  const encoded = encodeURIComponent(project);
  const merge = await gitlabRequest(`${prefix}/projects/${encoded}/merge_requests/${number}`, credential.token);
  const changes = await gitlabRequest(`${prefix}/projects/${encoded}/merge_requests/${number}/changes`, credential.token);
  return { provider: 'gitlab', change: {
    title: merge.title, repository: project, number,
    headSha: merge.sha,
    files: (changes.changes || []).filter((f: any) => f.diff).map((f: any): DiffFile => ({ path: f.new_path, patch: f.diff }))
  }};
}

export async function publishReviewReport(sourceUrl: string, credentials: CredentialLookup, reviewId: string, comments: ReviewComment[]) {
  const url = assertSupportedChangeUrl(sourceUrl);
  const marker = `<!-- review-orbit:${reviewId} -->`;
  const findings = comments.slice(0, 30).map((comment) => `- **${comment.confidence === 'high' ? '高置信度' : '仅供参考'}** \`${comment.path}${comment.line ? `:${comment.line}` : ''}\`：${comment.body}`).join('\n');
  const body = `## 审鉴 Review Orbit 评审报告\n\n${findings || '本次未发现需要报告的问题。'}\n\n${marker}`;
  if (url.hostname === 'github.com') {
    const credential = await credentials('github'); if (!credential) throw new Error('未配置已启用的 GitHub 凭证。');
    const { owner, repo, number } = githubUrl(url); const api = credential.baseUrl || 'https://api.github.com';
    const existing = await request(`${api}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`, credential.token);
    const match = (existing as any[]).find((comment) => comment.body?.includes(marker));
    if (match) return String(match.id);
    const response = await fetch(`${api}/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub 回评返回 ${response.status}: ${await response.text()}`);
    return String((await response.json() as any).id);
  }
  const credential = await credentials('gitlab'); if (!credential) throw new Error('未配置已启用的 GitLab 凭证。');
  const { project, number } = gitlabUrl(url); const api = (credential.baseUrl || 'https://gitlab.com/api/v4').replace(/\/$/, ''); const endpoint = `${api}/projects/${encodeURIComponent(project)}/merge_requests/${number}/notes`;
  const existing = await gitlabRequest(`${endpoint}?per_page=100`, credential.token);
  const match = (existing as any[]).find((note) => note.body?.includes(marker));
  if (match) return String(match.id);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'PRIVATE-TOKEN': credential.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitLab 回评返回 ${response.status}: ${await response.text()}`);
  return String((await response.json() as any).id);
}
