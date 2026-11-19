// 색인: 저장소에 맞는 어댑터를 모두 돌려 사실을 모으고 그래프 저장소에 넣어요.
// 색인기는 늘 저장소 전체를 돌리고, 그래프에는 사실이 달라진 파일만 반영해요(증분 반영).
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dartAdapter } from './adapters/dart.ts';
import { appendFacts, emptyFacts, type LanguageAdapter, type RepoInfo } from './facts.ts';
import { worktreeFingerprint } from './freshness.ts';
import { GraphStore, type FileChanges, type LanguageCounts } from './graph/store.ts';
import { run } from './run.ts';

const ADAPTERS: LanguageAdapter[] = [dartAdapter];

/** `index` 명령이 내는 색인 요약. */
export interface IndexSummary {
  repo: string;
  db: string;
  commit: string | null;
  adapters: string[];
  /** 색인한 뒤 그래프 전체의 파일·이름(심볼)·관계 수. */
  files: number;
  symbols: number;
  relations: number;
  /** 언어별 개수와 관계의 정밀/추정 비율. */
  languages: Record<string, LanguageCounts>;
  /** 이번에 그래프에 반영한 파일. 처음 색인이면 모두 added예요. */
  changes: FileChanges;
  dbBytes: number;
  /** 걸린 시간(밀리초). indexers: 색인기 실행, graph: 그래프 반영, total: 전체. */
  ms: { indexers: number; graph: number; total: number };
}

function repoInfo(root: string): { info: RepoInfo; commit: string | null } {
  const ls = run('git', ['ls-files', '-z'], root);
  if (!ls.ok) return { info: { root, trackedFiles: null }, commit: null };
  const head = run('git', ['rev-parse', 'HEAD'], root);
  return {
    info: { root, trackedFiles: ls.stdout.split('\0').filter(Boolean) },
    commit: head.ok ? head.stdout.trim() : null,
  };
}

export async function indexRepo(repoPath: string, dbPath: string): Promise<IndexSummary> {
  const started = performance.now();
  const root = resolve(repoPath);
  const { info, commit } = repoInfo(root);
  // 색인기를 돌리기 전에 잰 작업 트리 지문. 도는 사이에 파일이 바뀌면 다음 질문이 낡았다고 표시해요.
  const worktree = commit ? worktreeFingerprint(root) : null;
  const adapters = ADAPTERS.filter((a) => a.applies(info));
  if (adapters.length === 0) throw new Error(`색인할 언어를 찾지 못했어요: ${root}`);

  // 색인기 산출물은 저장소 밖 임시 폴더에 써서 저장소를 건드리지 않아요.
  const workDir = mkdtempSync(join(tmpdir(), 'code-atlas-'));
  const facts = emptyFacts();
  const indexersStarted = performance.now();
  try {
    for (const adapter of adapters) {
      appendFacts(facts, await adapter.index(info, workDir));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const indexersMs = performance.now() - indexersStarted;

  const store = GraphStore.open(dbPath);
  try {
    const graphStarted = performance.now();
    const changes = store.applyFacts(facts, { repoRoot: root, commit, worktree, indexedAt: new Date().toISOString() });
    const graphMs = performance.now() - graphStarted;
    return {
      repo: root,
      db: resolve(dbPath),
      commit,
      adapters: adapters.map((a) => a.name),
      ...store.counts(),
      languages: store.languages(),
      changes,
      dbBytes: statSync(dbPath).size,
      ms: { indexers: Math.round(indexersMs), graph: Math.round(graphMs), total: Math.round(performance.now() - started) },
    };
  } finally {
    store.close();
  }
}
