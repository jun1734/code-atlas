// 색인: 저장소에 있는 언어마다 정밀 어댑터를 돌리고, 정밀 색인기가 없거나 실패했거나 덮지 못한 파일은
// 추정 층(Tree-sitter)으로 메워 사실을 모으고 그래프 저장소에 넣어요. 어느 언어가 실패해도 색인 전체는 멈추지 않아요.
// 색인기는 늘 저장소 전체를 돌리고, 그래프에는 사실이 달라진 파일만 반영해요(증분 반영).
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFacts, dropFiles, emptyFacts, IndexerMissing, type Facts, type RepoInfo } from './facts.ts';
import { worktreeFingerprint } from './freshness.ts';
import { GraphStore, type FileChanges, type LanguageCounts } from './graph/store.ts';
import { inferredSource, listRepoFiles, repoView, runInferred } from './inferred/layer.ts';
import { LANGUAGES, type LanguageSetup } from './languages.ts';
import { gitRun } from './git.ts';

/**
 * 정밀 색인기를 설치되지 않은 것으로 칠 이름(쉼표로 여럿). 예: CODE_ATLAS_DISABLE_INDEXERS=scip-dart
 * 색인기를 지우지 않고 "없을 때"를 시험하거나, 정밀 색인기가 말썽일 때 추정 층만 쓰려고 둬요.
 */
export const DISABLE_INDEXERS_ENV = 'CODE_ATLAS_DISABLE_INDEXERS';

/** 정밀 색인기 대신 추정 층으로 색인한 언어 하나. */
export interface Fallback {
  language: string;
  /** 정밀 색인기 이름. */
  indexer: string;
  /** missing: 설치되어 있지 않음, failed: 돌았지만 실패함. */
  reason: 'missing' | 'failed';
  /** 정밀 색인기를 설치하는 명령. */
  install: string;
  /** 대신 색인한 추정 층(예: tree-sitter-dart). 그 언어의 추정 규칙이 없으면 null(그 언어는 색인되지 않았어요). */
  inferredBy: string | null;
  /** failed일 때 실패 내용. */
  error?: string;
}

/** `index` 명령이 내는 색인 요약. */
export interface IndexSummary {
  repo: string;
  db: string;
  commit: string | null;
  /** 사실을 낸 색인기(정밀 어댑터 이름, 추정 층 'tree-sitter-<언어>'). */
  adapters: string[];
  /** 정밀 색인기가 없거나 실패해서 추정 층으로 색인한 언어. 같은 안내가 stderr에도 나와요. */
  fallbacks: Fallback[];
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

function repoInfo(root: string): { info: RepoInfo; commit: string | null; isIgnored: (path: string) => boolean } {
  const ls = gitRun(root, ['ls-files', '-z']);
  if (!ls.ok) return { info: { root, trackedFiles: null }, commit: null, isIgnored: () => false };
  const head = gitRun(root, ['rev-parse', 'HEAD']);
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
  const r = gitRun(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
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
  // 색인기를 돌리기 전에 잰 작업 트리 지문. 도는 사이에 파일이 바뀌면 다음 질문이 낡았다고 표시해요.
  const worktree = commit ? worktreeFingerprint(root) : null;
  const files = listRepoFiles(info);
  const present = LANGUAGES.filter((l) => l.precise?.applies(info) || (l.inferred && [...files].some((p) => l.inferred!.owns(p))));
  if (present.length === 0) throw new Error(`색인할 언어를 찾지 못했어요: ${root}`);

  // 색인기 산출물은 저장소 밖 임시 폴더에 써서 저장소를 건드리지 않아요.
  const workDir = mkdtempSync(join(tmpdir(), 'code-atlas-'));
  const all = emptyFacts();
  const adapters: string[] = [];
  const fallbacks: Fallback[] = [];
  const indexersStarted = performance.now();
  try {
    for (const setup of present) {
      const done = await indexLanguage(setup, info, files, workDir);
      appendFacts(all, done.facts);
      adapters.push(...done.adapters);
      if (done.fallback) {
        fallbacks.push(done.fallback);
        process.stderr.write(fallbackNotice(done.fallback));
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  // git이 무시하는 파일은 어느 언어든 빼요. 생성된 코드와 빌드 산출물은 언어마다 달라서 어댑터가 빼요.
  const facts = dropFiles(all, isIgnored);
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
      adapters,
      fallbacks,
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

/**
 * 언어 하나를 색인해요: 정밀 어댑터 → (없거나 실패했거나 덮지 못한 파일이 있으면) 추정 층.
 * 정밀 사실이 있는 파일의 사실은 추정 층이 덮어쓰지 않아요(withoutCovered).
 */
async function indexLanguage(
  setup: LanguageSetup,
  info: RepoInfo,
  files: Set<string>,
  workDir: string,
): Promise<{ facts: Facts; adapters: string[]; fallback: Fallback | null }> {
  const adapters: string[] = [];
  let precise = emptyFacts();
  let fallback: Fallback | null = null;
  const { precise: adapter, inferred } = setup;
  if (adapter?.applies(info)) {
    const disabled = (process.env[DISABLE_INDEXERS_ENV] ?? '').split(',').map((s) => s.trim());
    const failed = (reason: Fallback['reason'], error?: string): Fallback => ({
      language: setup.language,
      indexer: adapter.name,
      reason,
      install: adapter.install,
      inferredBy: inferred ? inferredSource(inferred) : null,
      ...(error !== undefined ? { error } : {}),
    });
    if (disabled.includes(adapter.name)) fallback = failed('missing');
    else {
      try {
        precise = await adapter.index(info, workDir);
        adapters.push(adapter.name);
      } catch (e) {
        fallback = e instanceof IndexerMissing ? failed('missing') : failed('failed', e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (!inferred) return { facts: precise, adapters, fallback };

  // 정밀 사실이 덮지 못한 이 언어의 파일(패키지 밖 파일, 정밀 색인기가 없거나 실패한 경우 전부). 뺄 파일(생성된 코드 등)은 빼요.
  const covered = new Set(precise.files.map((f) => f.path));
  const view = repoView(info, files);
  const uncovered = [...files].filter((p) => inferred.owns(p) && !covered.has(p) && !inferred.excluded(p, view.read(p) ?? '', view));
  if (uncovered.length === 0) return { facts: precise, adapters, fallback };

  const guessed = withoutCovered(await runInferred(inferred, info, { emit: (p) => !covered.has(p), precise }), covered);
  if (guessed.files.length > 0) adapters.push(inferredSource(inferred));
  const facts = emptyFacts();
  appendFacts(facts, precise);
  appendFacts(facts, guessed);
  return { facts, adapters, fallback };
}

/** 정밀 사실이 있는 파일에 적힌 추정 사실(파일, 정의, 그 파일에서 나가는 관계)을 빼요. 그 파일로 가는 관계는 남겨요. */
function withoutCovered(facts: Facts, covered: Set<string>): Facts {
  return {
    files: facts.files.filter((f) => !covered.has(f.path)),
    symbols: facts.symbols.filter((s) => !covered.has(s.path)),
    relations: facts.relations.filter((r) => !covered.has(r.from.path)),
  };
}

/** 정밀 색인기 대신 추정 층으로 색인했다는 안내(stderr). 무엇을 어떻게 설치하는지 적어요. */
function fallbackNotice(f: Fallback): string {
  const what = f.reason === 'missing' ? `${f.indexer}(${f.language} 정밀 색인기)를 찾지 못했어요.` : `${f.indexer}(${f.language} 정밀 색인기)가 실패했어요: ${f.error}`;
  const then = f.inferredBy
    ? `${f.language} 파일은 추정 층(${f.inferredBy})으로 색인했어요. 답에 confidence: inferred로 나와요.`
    : `${f.language} 파일은 색인하지 않았어요(추정 규칙이 아직 없어요).`;
  const install = f.reason === 'missing' ? `설치: ${f.install}
설치한 뒤 다시 색인하면 정밀 색인으로 바뀌어요.` : `설치나 패키지 설정을 확인해요. 설치: ${f.install}`;
  return `code-atlas: ${what}
${then}
${install}
`;
}
