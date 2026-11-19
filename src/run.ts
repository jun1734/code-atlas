// 바깥 명령(dart, flutter, git)을 돌려요. Windows에서 dart/flutter는 .bat이라 셸을 거쳐야 해요.
import { spawnSync } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

const isWindows = process.platform === 'win32';

/** 셸에 넘길 인자를 따옴표로 감싸요. 인자에 큰따옴표가 있으면 거부해요. */
function quote(arg: string): string {
  if (arg.includes('"')) throw new Error(`인자에 큰따옴표를 쓸 수 없어요: ${arg}`);
  return /[\s&|<>^()%!]/.test(arg) ? `"${arg}"` : arg;
}

export function run(cmd: string, args: string[], cwd?: string): RunResult {
  const r = isWindows
    ? spawnSync([cmd, ...args].map(quote).join(' '), { cwd, shell: true, encoding: 'utf8' })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
  };
}

/** 실패하면 명령과 stderr를 담아 던져요. */
export function runOrThrow(cmd: string, args: string[], cwd?: string): string {
  const r = run(cmd, args, cwd);
  if (!r.ok) throw new Error(`명령 실패(${r.status}): ${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}
