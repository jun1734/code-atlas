// 도구 호출 경계의 테스트 틀: 예제 저장소를 임시 git 저장소로 복사해 색인하고,
// 명령줄 도구를 실제 프로세스로 불러 JSON 답을 받아요. 내부 모듈은 부르지 않아요.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');

export interface IndexedFixture {
  /** 색인한 예제 저장소 사본의 경로. */
  repo: string;
  /** 색인 명령의 JSON 답. */
  summary: any;
  /** 명령줄 도구에 질문을 던지고 JSON 답을 받아요. */
  ask(...args: string[]): any;
  /** 사본의 `git status --porcelain` 결과(무시된 파일 제외). */
  gitStatus(): string;
  /** 사본의 HEAD 커밋. */
  head(): string;
  dispose(): void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runCli(...args: string[]): any {
  const out = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** `test/fixtures/<name>`을 새 git 저장소로 복사해 커밋하고 색인해요. */
export function indexFixture(name: string): IndexedFixture {
  const work = mkdtempSync(join(tmpdir(), 'code-atlas-test-'));
  const repo = join(work, name);
  cpSync(join(root, 'test', 'fixtures', name), repo, {
    recursive: true,
    filter: (src) => !src.includes('.dart_tool'),
  });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture');
  const db = join(work, 'atlas.db');
  const summary = runCli('index', repo, '--db', db);
  return {
    repo,
    summary,
    ask: (...args) => runCli(...args, '--db', db),
    gitStatus: () => git(repo, 'status', '--porcelain'),
    head: () => git(repo, 'rev-parse', 'HEAD'),
    dispose: () => rmSync(work, { recursive: true, force: true }),
  };
}

/** `test/expected/<fixture>/<file>`의 정답 JSON. */
export function expected(fixture: string, file: string): any {
  return JSON.parse(readFileSync(join(root, 'test', 'expected', fixture, file), 'utf8'));
}
