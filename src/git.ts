// git 돌리기 한곳. git은 실행 파일이라 셸을 거치지 않아요(Windows에서도). 큰 출력(diff, ls-files)을 받을 수 있게 버퍼를 넉넉히 둬요.
import { spawnSync } from 'node:child_process';
import type { RunResult } from './run.ts';

/** git을 root에서 돌려요. 실패해도 던지지 않고 결과를 돌려줘요. env는 이 프로세스의 환경에 더해요. */
export function gitRun(root: string, args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 1 << 30,
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
  };
}

/** git을 돌려 stdout을 돌려줘요. 실패하면 명령과 stderr를 담아 던져요. */
export function git(root: string, args: string[], env: Record<string, string> = {}): string {
  const r = gitRun(root, args, env);
  if (!r.ok) throw new Error(`git ${args.join(' ')} 실패(${r.status}): ${r.stderr.trim()}`);
  return r.stdout;
}

/** git을 돌려 stdout을 돌려줘요. 실패하면(git 저장소가 아님 등) null. */
export function gitOrNull(root: string, args: string[]): string | null {
  const r = gitRun(root, args);
  return r.ok ? r.stdout : null;
}
