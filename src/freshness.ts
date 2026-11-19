// 색인이 낡았는지: 색인 뒤에 커밋이 바뀌었거나, 작업 트리가 색인할 때와 달라졌으면 낡은 거예요.
// 색인은 커밋이 아니라 작업 트리를 읽어요. 고친 채로 색인했다면 고친 파일이 있어도 낡지 않았어요.
// 그래서 색인할 때 "커밋과 다른 파일들"의 지문을 남기고, 물을 때 다시 재서 비교해요.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexMeta } from './graph/store.ts';
import { run } from './run.ts';

/**
 * 작업 트리에서 커밋과 다른 파일들(`git status`에 나오는 것, 무시된 파일 제외)의 상태와 내용으로 낸 지문.
 * 바뀐 파일이 없으면 빈 문자열, git 저장소가 아니면 null.
 */
export function worktreeFingerprint(root: string): string | null {
  // -z: 경로를 따옴표로 감싸지 않아요. -uall: 추적하지 않는 폴더도 파일 단위로 보여요.
  const status = run('git', ['status', '--porcelain', '-z', '-uall'], root);
  if (!status.ok) return null;
  const entries = status.stdout.split('\0').filter(Boolean);
  if (entries.length === 0) return '';
  const hash = createHash('sha256');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const code = entry.slice(0, 2);
    // 이름 바꾸기/복사는 다음 칸에 원래 경로가 와요.
    if (code.includes('R') || code.includes('C')) hash.update(`${entries[++i]}\0`);
    hash.update(`${entry}\0`);
    const file = join(root, entry.slice(3));
    if (existsSync(file) && statSync(file).isFile()) hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 낡았으면 true, 그대로면 false, git 저장소가 아니라 알 수 없으면 null. */
export function isStale(meta: IndexMeta): boolean | null {
  if (!meta.commit || !meta.repoRoot) return null;
  const head = run('git', ['rev-parse', 'HEAD'], meta.repoRoot);
  if (!head.ok) return null;
  if (head.stdout.trim() !== meta.commit) return true;
  const now = worktreeFingerprint(meta.repoRoot);
  if (now === null) return null;
  return now !== (meta.worktree ?? '');
}
