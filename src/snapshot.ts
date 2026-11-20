// 커밋 색인: 저장소의 한 커밋을 따로 색인해 둔 것. detect_changes가 "바꾸기 전"(또는 두 커밋 사이의 "바꾼 뒤")을 볼 때 써요.
// 커밋은 바뀌지 않아서 한 번 만든 색인을 계속 써요. 자리는 저장소 색인 옆(`<색인>@<커밋 앞 12자>.db`)이에요.
// 저장소는 바꾸지 않아요: 임시 폴더에 로컬 복제(--shared, 네트워크 없음)를 만들어 그 커밋을 꺼내 색인하고 지워요.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RepoInfo, ToolState } from './facts.ts';
import { git, gitRun } from './git.ts';
import { GraphStore } from './graph/store.ts';
import { indexRepo } from './indexer.ts';
import { LANGUAGES } from './languages.ts';

/** 커밋에 빌려 올 도구 상태: 빌릴 파일과, 빌린 것이 그 커밋에 맞는지 모르는 색인기(정밀 어댑터 이름). */
interface Borrowing {
  files: string[];
  unsure: Set<string>;
}

/**
 * 색인기가 읽지만 git이 무시해서 커밋에 없는 파일(도구 상태: 패키지 설정 등)을 지금 작업 트리에서 빌려 와요.
 * 어느 파일인지는 언어 어댑터가 알려 줘요(LanguageAdapter.toolState). 그 묶음의 sameAs(잠금 파일 등)가 커밋과 작업 트리에서
 * 다르면 빌린 것이 그 커밋에 맞는지 몰라서, 그 색인기는 unsure에 들어요(그 색인기의 사실은 추정으로 낮춰요).
 */
function planBorrowing(root: string, commit: string): Borrowing {
  const tracked = git(root, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);
  // 어댑터는 trackedFiles(그 커밋의 파일)만 보고 묶음을 알려 줘요.
  const info: RepoInfo = { root, trackedFiles: tracked };
  const out: Borrowing = { files: [], unsure: new Set() };
  for (const { precise } of LANGUAGES) {
    if (!precise) continue;
    const states: ToolState[] = precise.toolState(info);
    for (const state of states) {
      const present = state.files.filter((f) => existsSync(join(root, f)));
      if (present.length === 0) continue;
      out.files.push(...present);
      if (!state.sameAs.every((p) => sameInCommit(root, commit, p))) out.unsure.add(precise.name);
    }
  }
  return out;
}

/**
 * 파일이 커밋과 작업 트리에서 같은지. git의 개체 id로 견줘요(줄 끝 바꾸기 등 git의 정리 규칙을 거친 내용).
 * 없는 것끼리는 같고, 작업 트리에서 git이 무시하는 파일은 없는 것으로 봐요.
 */
function sameInCommit(root: string, commit: string, path: string): boolean {
  const then = gitRun(root, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  const ignored = gitRun(root, ['check-ignore', '-q', '--', path]).ok;
  const now = !ignored && existsSync(join(root, path)) ? gitRun(root, ['hash-object', '--', path]) : null;
  const thenId = then.ok ? then.stdout.trim() : null;
  const nowId = now?.ok ? now.stdout.trim() : null;
  return thenId === nowId;
}

/** 커밋 색인의 자리. 빌린 도구 상태가 그 커밋에 맞는지 모르고 만든 색인은 따로 둬요(`…-unsure.db`). */
export function commitDb(mainDb: string, commit: string, unsure = false): string {
  return mainDb.replace(/\.db$/, '') + `@${commit.slice(0, 12)}${unsure ? '-unsure' : ''}.db`;
}

/** 이미 만든 커밋 색인이 쓸 만한지(스키마가 같고 그 커밋을 색인한 것). */
function usable(db: string, commit: string): boolean {
  try {
    const store = GraphStore.openExisting(db);
    if (!store) return false;
    try {
      return store.meta().commit === commit;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

/**
 * 저장소(root)의 커밋 하나를 색인한 색인 파일을 돌려줘요. 없으면 만들어요.
 * 그 색인의 repoRoot는 지워진 임시 폴더라, 저장소 설정은 부르는 쪽이 지금 저장소에서 읽어요.
 * 빌린 도구 상태가 그 커밋에 맞는지 모르는 색인기(잠금 파일이 지금과 다름)의 사실은 confidence: inferred로 낮춰 넣어요.
 * 열쇠는 그대로라 저장소 색인과 짝지을 수 있어요.
 */
export async function indexCommit(root: string, mainDb: string, commit: string): Promise<string> {
  const borrowing = planBorrowing(root, commit);
  const db = commitDb(mainDb, commit, borrowing.unsure.size > 0);
  if (usable(db, commit)) return db;
  const work = mkdtempSync(join(tmpdir(), 'code-atlas-commit-'));
  try {
    const clone = join(work, basename(root));
    git(root, ['clone', '--quiet', '--shared', '--no-checkout', root, clone]);
    git(clone, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit]);
    for (const file of borrowing.files) {
      mkdirSync(dirname(join(clone, file)), { recursive: true });
      copyFileSync(join(root, file), join(clone, file));
    }
    // 다 만든 뒤에 제자리로 옮겨요. 도중에 멈춰도 반쯤 된 색인을 쓰지 않게요.
    // 같은 폴더에 만들어 옮겨요(다른 드라이브 사이에서는 옮기기가 안 돼요).
    const partial = `${db}.partial`;
    rmSync(partial, { force: true });
    await indexRepo(clone, partial, { untrusted: borrowing.unsure });
    rmSync(db, { force: true });
    renameSync(partial, db);
    return db;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
