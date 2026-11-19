// 색인이 낡았는지: 색인 뒤에 커밋이 바뀌었거나 작업 트리에 바뀐 파일이 있으면 낡은 거예요.
import type { IndexMeta } from './graph/store.ts';
import { run } from './run.ts';

/** 낡았으면 true, 그대로면 false, git 저장소가 아니라 알 수 없으면 null. */
export function isStale(meta: IndexMeta): boolean | null {
  if (!meta.commit || !meta.repoRoot) return null;
  const head = run('git', ['rev-parse', 'HEAD'], meta.repoRoot);
  if (!head.ok) return null;
  if (head.stdout.trim() !== meta.commit) return true;
  const status = run('git', ['status', '--porcelain'], meta.repoRoot);
  if (!status.ok) return null;
  return status.stdout.trim() !== '';
}
