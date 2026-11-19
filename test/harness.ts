// 도구 호출 경계의 테스트 틀: 예제 저장소를 임시 git 저장소로 복사해 색인하고,
// 명령줄 도구를 실제 프로세스로 불러 JSON 답을 받아요. 내부 모듈은 부르지 않아요.
import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
/** 예제 저장소들이 있는 폴더. */
export const fixtureDir = join(root, 'test', 'fixtures');

export interface IndexedFixture {
  /** 명령줄 도구에 질문을 던지고 JSON 답을 받아요. */
  ask(...args: string[]): any;
  /** 사본의 `git status --porcelain` 결과(무시된 파일 제외). */
  gitStatus(): string;
  /** 사본의 HEAD 커밋. */
  head(): string;
  /** 사본의 파일 끝에 글을 덧붙여요(색인은 다시 하지 않아요). */
  append(path: string, text: string): void;
  /** 사본의 파일을 이 글로 바꿔요. 없으면 만들어요(색인은 다시 하지 않아요). */
  write(path: string, text: string): void;
  /** 사본의 파일 글을 읽어요. */
  read(path: string): string;
  /** 사본의 파일을 지워요(색인은 다시 하지 않아요). */
  remove(path: string): void;
  /** 사본의 파일 이름을 바꿔요(색인은 다시 하지 않아요). */
  rename(from: string, to: string): void;
  /** 사본을 늘 쓰던 색인 파일에 다시 색인하고 색인 요약을 돌려줘요. */
  reindex(): any;
  /** 사본을 새 색인 파일에 처음부터 색인하고, 그 색인에 묻는 함수와 요약을 돌려줘요. */
  indexFresh(): { summary: any; ask(...args: string[]): any };
  /** 처음 색인할 때 나온 요약. */
  readonly firstSummary: any;
  /** 사본의 작업 트리를 커밋 상태로 되돌려요. */
  restore(): void;
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

/**
 * `test/fixtures/<name>`을 새 git 저장소로 복사해 커밋하고 색인해요.
 * 색인 도구는 pub get을 대신 돌리지 않으니, 개발자가 하듯 여기서 먼저 돌려요(lock 고정, 의존성 없음).
 */
export function indexFixture(name: string): IndexedFixture {
  const work = mkdtempSync(join(tmpdir(), 'code-atlas-test-'));
  const repo = join(work, name);
  cpSync(join(fixtureDir, name), repo, {
    recursive: true,
    filter: (src) => !src.includes('.dart_tool'),
  });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture');
  if (existsSync(join(repo, 'pubspec.yaml'))) {
    execSync('dart pub get --enforce-lockfile', { cwd: repo, stdio: 'ignore' });
  }
  const db = join(work, 'atlas.db');
  const firstSummary = runCli('index', repo, '--db', db);
  let fresh = 0;
  return {
    ask: (...args) => runCli(...args, '--db', db),
    gitStatus: () => git(repo, 'status', '--porcelain'),
    head: () => git(repo, 'rev-parse', 'HEAD'),
    append: (path, text) => appendFileSync(join(repo, path), text),
    write: (path, text) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    },
    read: (path) => readFileSync(join(repo, path), 'utf8'),
    remove: (path) => rmSync(join(repo, path)),
    rename: (from, to) => {
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      renameSync(join(repo, from), join(repo, to));
    },
    reindex: () => runCli('index', repo, '--db', db),
    indexFresh: () => {
      const freshDb = join(work, `fresh-${++fresh}.db`);
      const summary = runCli('index', repo, '--db', freshDb);
      return { summary, ask: (...args) => runCli(...args, '--db', freshDb) };
    },
    firstSummary,
    restore: () => {
      git(repo, 'checkout', '--', '.');
    },
    dispose: () => rmSync(work, { recursive: true, force: true }),
  };
}

/** `test/expected/<fixture>/<file>`의 정답 JSON. */
export function expected(fixture: string, file: string): any {
  return JSON.parse(readFileSync(join(root, 'test', 'expected', fixture, file), 'utf8'));
}
