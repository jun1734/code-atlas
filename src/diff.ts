// git이 말하는 변경: 두 커밋 사이, 또는 커밋과 작업 트리 사이에서 바뀐 파일과 줄.
// 저장소는 바꾸지 않아요. 작업 트리를 볼 때는 임시 git 색인 파일에 담아 비교해요(사용자의 staging은 그대로).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gitRun } from './git.ts';
import { UserError } from './locate.ts';

/** 줄 범위(1부터, 끝 포함). */
export interface LineSpan {
  start: number;
  end: number;
}

/** 파일 하나의 변경. 새 파일은 oldPath가, 지운 파일은 newPath가 null이에요. 옮긴 파일은 둘이 달라요. */
export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** 바꾸기 전 파일에서 지우거나 고친 줄. */
  oldLines: LineSpan[];
  /** 바꾼 뒤 파일에서 더하거나 고친 줄. */
  newLines: LineSpan[];
}

/** 경로를 따옴표로 감싸지 않게(core.quotePath=false) git을 돌려요. 실패하면 고칠 방법을 담은 UserError. */
function git(root: string, args: string[], env: Record<string, string> = {}): string {
  const r = gitRun(root, ['-c', 'core.quotePath=false', ...args], env);
  if (!r.ok) throw new UserError(`git ${args.join(' ')} 실패: ${r.stderr.trim()}`);
  return r.stdout;
}

/** 커밋을 가리키는 글(커밋, 브랜치, 태그, HEAD~1 …)을 커밋 해시로. 없으면 UserError. */
export function resolveCommit(root: string, ref: string): string {
  const r = gitRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!r.ok) throw new UserError(`커밋을 찾지 못했어요: ${ref}`);
  return r.stdout.trim();
}

const DIFF_ARGS = ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * base 커밋에서 head 커밋(null이면 작업 트리)까지 바뀐 파일과 줄.
 * 작업 트리는 추적하지 않는 새 파일(무시된 것 빼고)까지 봐요. 옮긴 파일은 git의 이름 바꾸기 찾기(-M)로 알아봐요.
 */
export function diffFiles(root: string, base: string, head: string | null): FileDiff[] {
  if (head !== null) return parseDiff(git(root, [...DIFF_ARGS, base, head]));
  // 작업 트리: 지금 git 색인의 사본에 작업 트리 전부를 담고(git add -A), 그 사본과 base를 비교해요.
  const tmp = mkdtempSync(join(tmpdir(), 'code-atlas-diff-'));
  try {
    const indexFile = join(tmp, 'index');
    const current = git(root, ['rev-parse', '--git-path', 'index']).trim();
    const currentPath = isAbsolute(current) ? current : join(root, current);
    if (existsSync(currentPath)) copyFileSync(currentPath, indexFile);
    const env = { GIT_INDEX_FILE: indexFile };
    git(root, ['add', '-A'], env);
    return parseDiff(git(root, [...DIFF_ARGS, '--cached', base], env));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `git diff -U0`의 글을 파일별 변경으로. 내용 없이 바뀐 파일(이진 파일, 빈 파일, 권한만)은 이름 바꾸기가 아니면 빼요. */
export function parseDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: (FileDiff & { inHunks: boolean; renamed: boolean; seen: boolean }) | null = null;
  const flush = () => {
    if (cur && (cur.seen || cur.renamed)) {
      const { inHunks: _h, renamed: _r, seen: _s, ...diff } = cur;
      out.push(diff);
    }
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { oldPath: null, newPath: null, oldLines: [], newLines: [], inHunks: false, renamed: false, seen: false };
      continue;
    }
    if (!cur) continue;
    if (!cur.inHunks) {
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length);
        cur.renamed = true;
      } else if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length);
        cur.renamed = true;
      } else if (line.startsWith('--- ')) {
        // 경로에 빈칸이 있으면 git이 끝에 탭을 붙여요.
        cur.oldPath = line === '--- /dev/null' ? null : line.slice('--- a/'.length).replace(/\t$/, '');
        cur.seen = true;
      } else if (line.startsWith('+++ ')) {
        cur.newPath = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length).replace(/\t$/, '');
        cur.seen = true;
      }
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      cur.inHunks = true;
      const [a, b, c, d] = [Number(hunk[1]), Number(hunk[2] ?? 1), Number(hunk[3]), Number(hunk[4] ?? 1)];
      if (b > 0) cur.oldLines.push({ start: a, end: a + b - 1 });
      if (d > 0) cur.newLines.push({ start: c, end: c + d - 1 });
    }
  }
  flush();
  return out;
}
