export type ProviderKind = 'openai' | 'github' | 'gitlab';
export type Confidence = 'high' | 'advisory';
export type ReviewStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type ReviewComment = {
  path: string;
  line?: number;
  body: string;
  confidence: Confidence;
  evidence: Array<{ source: string; detail: string }>;
};

export type DiffFile = { path: string; patch: string; additions?: number; deletions?: number };
export type ChangeRequest = { title: string; repository: string; number: string; files: DiffFile[]; headSha?: string };
