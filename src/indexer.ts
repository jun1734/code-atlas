// 색인: 저장소에 맞는 어댑터를 모두 돌려 사실을 모으고 그래프 저장소에 넣어요.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dartAdapter } from './adapters/dart.ts';
import { appendFacts, dropFiles, emptyFacts, type LanguageAdapter, type RepoInfo } from './facts.ts';
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

function repoInfo(root: string): { info: RepoInfo; commit: string | null; isIgnored: (path: string) => boolean } {
  const ls = run('git', ['ls-files', '-z'], root);
  if (!ls.ok) return { info: { root, trackedFiles: null }, commit: null, isIgnored: () => false };
  const head = run('git', ['rev-parse', 'HEAD'], root);
  return {
    info: { root, trackedFiles: ls.stdout.split('\0').filter(Boolean) },
    commit: head.ok ? head.stdout.trim() : null,
    isIgnored: gitIgnored(root),
  };
}

/**
 * git이 무시하는 파일인지. 무시되는 폴더는 통째로 한 줄('dir/')로 받아요(--directory).
 * 이미 추적 중인 파일은 무시 규칙에 걸려도 여기 나오지 않아요(git과 같아요).
 */
function gitIgnored(root: string): (path: string) => boolean {
  const r = run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], root);
  if (!r.ok) return () => false;
  const entries = r.stdout.split('\0').filter(Boolean);
  const files = new Set(entries.filter((e) => !e.endsWith('/')));
  const dirs = entries.filter((e) => e.endsWith('/'));
  return (path) => files.has(path) || dirs.some((d) => path.startsWith(d));
}

export async function indexRepo(repoPath: string, dbPath: string): Promise<IndexSummary> {
  const started = performance.now();
  const root = resolve(repoPath);
  const { info, commit, isIgnored } = repoInfo(root);
  const adapters = ADAPTERS.filter((a) => a.applies(info));
  if (adapters.length === 0) throw new Error(`색인할 언어를 찾지 못했어요: ${root}`);

  // 색인기 산출물은 저장소 밖 임시 폴더에 써서 저장소를 건드리지 않아요.
  const workDir = mkdtempSync(join(tmpdir(), 'code-atlas-'));
  const all = emptyFacts();
  try {
    for (const adapter of adapters) {
      appendFacts(all, await adapter.index(info, workDir));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  // git이 무시하는 파일은 어느 언어든 빼요. 생성된 코드와 빌드 산출물은 언어마다 달라서 어댑터가 빼요.
  const facts = dropFiles(all, isIgnored);

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
