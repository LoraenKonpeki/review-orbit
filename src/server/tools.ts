import type { DiffFile, ReviewComment } from '../shared/types.js';

export type ToolManifest = {
  id: string;
  name: string;
  description: string;
  category: 'static' | 'sandboxed';
  languages: string[];
  defaultEnabled: boolean;
  execution: { network: false; executesRepositoryCode: false; timeoutMs: number };
};
export type ToolResult = { toolId: string; comments: ReviewComment[]; detail: string };
export type ReviewTool = { manifest: ToolManifest; run(files: DiffFile[]): Promise<ToolResult> };

const staticRules: ReviewTool = {
  manifest: {
    id: 'builtin-static-rules', name: '内建安全规则', description: '只分析 diff 的确定性高风险模式检查。', category: 'static', languages: ['*'], defaultEnabled: true,
    execution: { network: false, executesRepositoryCode: false, timeoutMs: 5_000 }
  },
  async run(files) {
    const comments: ReviewComment[] = [];
    for (const file of files) {
      const lines = file.patch.split('\n');
      lines.forEach((line, i) => {
        if (!line.startsWith('+') || line.startsWith('+++')) return;
        if (/\beval\s*\(|new Function\s*\(/.test(line)) comments.push({ path: file.path, line: i + 1, confidence: 'high', body: '请避免动态执行代码。`eval` 和 `new Function` 会让不可信输入成为可执行代码，并绕过静态分析。', evidence: [{ source: 'builtin-static-rules/no-dynamic-code', detail: '新增行命中了动态代码执行 API。' }] });
        if (/\b(disableTlsVerification|rejectUnauthorized\s*:\s*false|verify\s*=\s*False)\b/.test(line)) comments.push({ path: file.path, line: i + 1, confidence: 'high', body: '此处关闭了 TLS 证书校验。除明确隔离的测试场景外，应始终保持证书校验开启。', evidence: [{ source: 'builtin-static-rules/no-insecure-tls', detail: '新增行命中了 TLS 证书校验关闭模式。' }] });
      });
    }
    return { toolId: 'builtin-static-rules', comments, detail: `发现 ${comments.length} 条确定性问题` };
  }
};

// 仅声明类型检查能力，不授予执行仓库脚本的隐式权限。
const typecheck: ReviewTool = {
  manifest: {
    id: 'typecheck', name: '沙箱类型检查', description: '使用固定版本分析器的可选语言类型检查。', category: 'sandboxed', languages: ['TypeScript', 'JavaScript'], defaultEnabled: false,
    execution: { network: false, executesRepositoryCode: false, timeoutMs: 30_000 }
  },
  async run() {
    return { toolId: 'typecheck', comments: [], detail: '尚未配置沙箱执行器；未执行仓库代码。' };
  }
};

const registry = new Map<string, ReviewTool>([staticRules, typecheck].map((tool) => [tool.manifest.id, tool]));
export const toolManifests = () => [...registry.values()].map((tool) => tool.manifest);
export const getTool = (id: string) => registry.get(id);
export async function runEnabledTools(files: DiffFile[], enabled: string[]) {
  return Promise.all(enabled.map(async (id) => {
    const tool = getTool(id);
    return tool ? tool.run(files) : undefined;
  })).then((results) => results.filter((value): value is ToolResult => Boolean(value)));
}
