// 커밋 색인: 저장소의 한 커밋을 따로 색인해 둔 것. detect_changes가 "바꾸기 전"(또는 두 커밋 사이의 "바꾼 뒤")을 볼 때 써요.
// 커밋은 바뀌지 않아서 한 번 만든 색인을 계속 써요. 자리는 저장소 색인 옆(`<색인>@<커밋 앞 12자>.db`)이에요.
// 저장소는 바꾸지 않아요: 임시 폴더에 로컬 복제(--shared, 네트워크 없음)를 만들어 그 커밋을 꺼내 색인하고 지워요.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { GraphStore } from './graph/store.ts';
import { indexRepo } from './indexer.ts';
import { runOrThrow } from './run.ts';

/**
 * 색인기가 읽지만 git이 무시해서 커밋에 없는 파일(패키지 설정). 꺼낸 커밋에는 없으니 지금 작업 트리의 같은 자리에서 빌려 와요.
 * 언어 어댑터가 알려 주는 것이 맞지만 어댑터 인터페이스에 아직 그 칸이 없어서 여기 적어요.
 * 그 커밋의 의존성이 지금과 다르면 빌린 설정이 맞지 않을 수 있어요(그때는 그 패키지 밖의 이름을 놓칠 수 있어요).
 */
const TOOL_STATE_FILES = ['.dart_tool/package_config.json', '.dart_tool/package_graph.json'];

/** 커밋 색인의 자리. */
export function commitDb(mainDb: string, commit: string): string {
  return mainDb.replace(/\.db$/, '') + `@${commit.slice(0, 12)}.db`;
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
 */
export async function indexCommit(root: string, mainDb: string, commit: string): Promise<string> {
  const db = commitDb(mainDb, commit);
  if (usable(db, commit)) return db;
  const work = mkdtempSync(join(tmpdir(), 'code-atlas-commit-'));
  try {
    const clone = join(work, basename(root));
    runOrThrow('git', ['clone', '--quiet', '--shared', '--no-checkout', root, clone]);
    runOrThrow('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], clone);
    const dirs = new Set(['']);
    for (const f of runOrThrow('git', ['ls-files', '-z'], clone).split('\0')) {
      for (let d = dirname(f); d !== '.' && d !== '' && !dirs.has(d); d = dirname(d)) dirs.add(d);
    }
    for (const dir of dirs) {
      for (const file of TOOL_STATE_FILES) {
        const from = join(root, dir, file);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(join(clone, dir, file)), { recursive: true });
        copyFileSync(from, join(clone, dir, file));
      }
    }
    // 다 만든 뒤에 제자리로 옮겨요. 도중에 멈춰도 반쯤 된 색인을 쓰지 않게요.
    // 같은 폴더에 만들어 옮겨요(다른 드라이브 사이에서는 옮기기가 안 돼요).
    const partial = `${db}.partial`;
    rmSync(partial, { force: true });
    await indexRepo(clone, partial);
    rmSync(db, { force: true });
    renameSync(partial, db);
    return db;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
