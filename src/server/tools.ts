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
    id: 'builtin-static-rules', name: 'Security Rules', description: '只分析 diff 的确定性高风险模式检查。', category: 'static', languages: ['*'], defaultEnabled: true,
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
    id: 'typecheck', name: 'typecheck', description: '使用固定版本分析器的可选语言类型检查。', category: 'sandboxed', languages: ['TypeScript', 'JavaScript'], defaultEnabled: false,
    execution: { network: false, executesRepositoryCode: false, timeoutMs: 30_000 }
  },
  async run() {
    return { toolId: 'typecheck', comments: [], detail: '尚未配置沙箱执行器；未执行仓库代码。' };
  }
};

const dependencyGuard: ReviewTool = {
  manifest: { id: 'dependency-guard', name: 'Dependency Guard', description: '检查新增依赖中的浮动版本、未加密下载地址与明显高风险来源。', category: 'static', languages: ['*'], defaultEnabled: true, execution: { network: false, executesRepositoryCode: false, timeoutMs: 5_000 } },
  async run(files) {
    const comments: ReviewComment[] = [];
    for (const file of files.filter((item) => /(?:package\.json|requirements.*\.txt|go\.mod|Cargo\.toml|pom\.xml)$/i.test(item.path))) {
      file.patch.split('\n').forEach((line, index) => {
        if (!line.startsWith('+') || line.startsWith('+++')) return;
        if (/(?:"(?:latest|\*)"|==\*|http:\/\/)/i.test(line)) comments.push({ path: file.path, line: index + 1, confidence: 'high', body: '新增依赖使用了浮动版本或非 HTTPS 下载地址，会降低构建可复现性并扩大供应链风险。请固定版本并使用受信任的 HTTPS 源。', evidence: [{ source: 'dependency-guard', detail: '新增依赖行命中了浮动版本或非 HTTPS 源规则。' }] });
      });
    }
    return { toolId: 'dependency-guard', comments, detail: `发现 ${comments.length} 条依赖风险` };
  }
};

const querySafety: ReviewTool = {
  manifest: { id: 'query-safety', name: 'Query Safety', description: '检查新增代码中疑似由字符串拼接构造的 SQL 查询。', category: 'static', languages: ['Python', 'TypeScript', 'JavaScript', 'Java'], defaultEnabled: true, execution: { network: false, executesRepositoryCode: false, timeoutMs: 5_000 } },
  async run(files) {
    const comments: ReviewComment[] = [];
    for (const file of files) file.patch.split('\n').forEach((line, index) => {
      if (line.startsWith('+') && !line.startsWith('+++') && /(?:SELECT|INSERT|UPDATE|DELETE).*(?:\+|\$\{|%s|\.format\()/i.test(line)) comments.push({ path: file.path, line: index + 1, confidence: 'advisory', body: '此查询疑似通过字符串拼接构造。请确认使用参数化查询，避免外部输入改变 SQL 语义。', evidence: [{ source: 'query-safety', detail: '新增行同时包含 SQL 关键字和动态字符串构造模式。' }] });
    });
    return { toolId: 'query-safety', comments, detail: `发现 ${comments.length} 条查询安全提示` };
  }
};

const errorHandling: ReviewTool = {
  manifest: { id: 'error-handling', name: 'Error Handling', description: '检查新增的空异常处理与被静默吞掉的错误。', category: 'static', languages: ['Python', 'TypeScript', 'JavaScript'], defaultEnabled: true, execution: { network: false, executesRepositoryCode: false, timeoutMs: 5_000 } },
  async run(files) {
    const comments: ReviewComment[] = [];
    for (const file of files) file.patch.split('\n').forEach((line, index) => {
      if (line.startsWith('+') && !line.startsWith('+++') && /(?:catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*pass)/.test(line)) comments.push({ path: file.path, line: index + 1, confidence: 'advisory', body: '这里会静默吞掉异常，排障和恢复都会变得困难。请至少记录上下文，或明确处理可预期的错误类型。', evidence: [{ source: 'error-handling', detail: '新增行命中了空异常处理模式。' }] });
    });
    return { toolId: 'error-handling', comments, detail: `发现 ${comments.length} 条异常处理提示` };
  }
};

const registry = new Map<string, ReviewTool>([staticRules, dependencyGuard, querySafety, errorHandling, typecheck].map((tool) => [tool.manifest.id, tool]));
export const toolManifests = () => [...registry.values()].map((tool) => tool.manifest);
export const getTool = (id: string) => registry.get(id);
export async function runEnabledTools(files: DiffFile[], enabled: string[]) {
  return Promise.all(enabled.map(async (id) => {
    const tool = getTool(id);
    return tool ? tool.run(files) : undefined;
  })).then((results) => results.filter((value): value is ToolResult => Boolean(value)));
}
