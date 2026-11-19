// 색인: 저장소에 맞는 어댑터를 모두 돌려 사실을 모으고 그래프 저장소에 넣어요.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dartAdapter } from './adapters/dart.ts';
import { appendFacts, emptyFacts, type LanguageAdapter, type RepoInfo } from './facts.ts';
import { GraphStore } from './graph/store.ts';
import { run } from './run.ts';

const ADAPTERS: LanguageAdapter[] = [dartAdapter];

export interface IndexSummary {
  repo: string;
  db: string;
  commit: string | null;
  adapters: string[];
  files: number;
  symbols: number;
  relations: number;
  dbBytes: number;
  ms: number;
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
  const adapters = ADAPTERS.filter((a) => a.applies(info));
  if (adapters.length === 0) throw new Error(`색인할 언어를 찾지 못했어요: ${root}`);

  // 색인기 산출물은 저장소 밖 임시 폴더에 써서 저장소를 건드리지 않아요.
  const workDir = mkdtempSync(join(tmpdir(), 'code-atlas-'));
  const facts = emptyFacts();
  try {
    for (const adapter of adapters) {
      appendFacts(facts, await adapter.index(info, workDir));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const store = GraphStore.open(dbPath);
  try {
    store.replaceAll(facts, { repoRoot: root, commit, indexedAt: new Date().toISOString() });
    return {
      repo: root,
      db: resolve(dbPath),
      commit,
      adapters: adapters.map((a) => a.name),
      ...store.counts(),
      dbBytes: statSync(dbPath).size,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    store.close();
  }
}
