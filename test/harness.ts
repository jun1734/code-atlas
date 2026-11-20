// 도구 호출 경계의 테스트 틀: 예제 저장소를 임시 git 저장소로 복사해 색인하고,
// 명령줄 도구와 MCP 서버를 실제 프로세스로 불러 JSON 답을 받아요. 내부 모듈은 부르지 않아요.
// 모든 도구 프로세스는 네트워크 차단 장치(test/no-network.ts)를 단 채로 돌아요.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
/** 예제 저장소들이 있는 폴더. */
export const fixtureDir = join(root, 'test', 'fixtures');
/** 네트워크를 쓰려 하면 프로세스를 멈추는 장치. 모든 도구 프로세스에 `--import`로 달아요. */
export const NO_NETWORK = pathToFileURL(join(root, 'test', 'no-network.ts')).href;
/** 차단 장치가 네트워크 시도를 잡으면 이 종료 코드로 끝나요. */
export const NETWORK_EXIT = 97;
/**
 * 도구가 띄우는 자식 프로세스(scip-dart 등 Node가 아닌 색인기)에는 `--import` 장치가 닿지 않아요.
 * 그래서 모든 도구 프로세스에 닫힌 곳(127.0.0.1:9)을 가리키는 pub 저장소와 HTTP 프록시를 줘요.
 * 자식이 pub이나 표준 HTTP 클라이언트로 네트워크를 쓰려 하면 바로 연결이 거절돼 실패해요.
 * 날 소켓까지 막지는 못해요(한계는 README의 "색인은 저장소를 바꾸지 않아요"와 docs/contract.md 약속 7).
 */
export const CHILD_NETWORK_TRAP: Record<string, string> = {
  PUB_HOSTED_URL: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '',
  no_proxy: '',
};

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 명령줄 도구를 돌려 종료 코드와 출력을 그대로 받아요. */
export function runCliRaw(args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, ['--import', NO_NETWORK, cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...CHILD_NETWORK_TRAP, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runCli(args: string[], env: Record<string, string> = {}): any {
  const r = runCliRaw(args, env);
  if (r.status !== 0) throw new Error(`명령줄 실패(${r.status}): ${args.join(' ')}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

export interface McpSession {
  /** 도구 이름 목록. */
  tools(): Promise<string[]>;
  /** 도구를 불러 답(JSON)을 받아요. 오류 답이면 던져요. */
  call(name: string, args: Record<string, unknown>): Promise<any>;
  /** 도구를 불러 날것의 결과(isError, 글)를 받아요. */
  callRaw(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  close(): Promise<void>;
}

/** `code-atlas mcp`를 실제 프로세스로 띄우고 공식 SDK 클라이언트로 붙어요. */
export async function startMcp(opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', NO_NETWORK, cli, 'mcp'],
    cwd: opts.cwd,
    env: { ...(process.env as Record<string, string>), ...CHILD_NETWORK_TRAP, ...opts.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'code-atlas-test', version: '0.0.0' });
  await client.connect(transport);
  const callRaw = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { isError: r.isError === true, text: content.map((c) => c.text ?? '').join('') };
  };
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name, args) => {
      const r = await callRaw(name, args);
      if (r.isError) throw new Error(`MCP 오류 답: ${r.text}`);
      return JSON.parse(r.text);
    },
    callRaw,
    close: () => client.close(),
  };
}

export interface IndexedFixture {
  /** 사본 저장소의 절대 경로. */
  repo: string;
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
  /** 처음 색인할 때 stderr에 나온 글(정밀 색인기가 없을 때의 안내 등). */
  readonly firstLog: string;
  /** 사본에서 git 명령을 돌리고 출력(앞뒤 공백 뺌)을 받아요. */
  git(...args: string[]): string;
  /** 사본의 작업 트리 전부(새 파일 포함)를 커밋하고 새 HEAD를 돌려줘요. */
  commit(message: string): string;
  /** 사본의 작업 트리를 커밋 상태로 되돌려요(추적하지 않는 새 파일도 지워요. 무시된 파일은 둬요). */
  restore(): void;
  dispose(): void;
}

export interface FixtureOptions {
  /**
   * 색인 폴더(CODE_ATLAS_HOME). 주면 `--db` 없이 기본 자리에 색인하고 `--repo`로 물어요.
   * 여러 저장소를 한 폴더에 색인해 두고 고르는 상황을 만들 때 써요.
   */
  home?: string;
  /** 커밋 전에 사본에 더할 파일(저장소 기준 경로 → 내용). */
  extraFiles?: Record<string, string>;
  /** 모든 도구 프로세스에 더할 환경 변수. 예: 정밀 색인기를 없는 것으로 치는 `CODE_ATLAS_DISABLE_INDEXERS`. */
  env?: Record<string, string>;
  /** `dart pub get`을 돌릴 폴더(저장소 기준). 없으면 뿌리에 pubspec.yaml이 있을 때 뿌리만. */
  pubGetIn?: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * `test/fixtures/<name>`을 새 git 저장소로 복사해 커밋하고 색인해요.
 * 색인 도구는 pub get을 대신 돌리지 않으니, 개발자가 하듯 여기서 먼저 돌려요(lock 고정).
 */
export function indexFixture(name: string, opts: FixtureOptions = {}): IndexedFixture {
  const work = mkdtempSync(join(tmpdir(), 'code-atlas-test-'));
  const repo = join(work, name);
  cpSync(join(fixtureDir, name), repo, {
    recursive: true,
    filter: (src) => !src.includes('.dart_tool'),
  });
  for (const [path, text] of Object.entries(opts.extraFiles ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture');
  for (const dir of opts.pubGetIn ?? (existsSync(join(repo, 'pubspec.yaml')) ? [''] : [])) {
    execSync('dart pub get --enforce-lockfile', { cwd: join(repo, dir), stdio: 'ignore' });
  }
  // 색인 명령의 꼴(어느 색인 파일에 쓰는지)과 질문 꼴. home을 주면 기본 자리, 아니면 --db.
  const env: Record<string, string> = { ...opts.env, ...(opts.home ? { CODE_ATLAS_HOME: opts.home } : {}) };
  const db = join(work, 'atlas.db');
  const where = opts.home ? ['--repo', repo] : ['--db', db];
  const indexArgs = opts.home ? ['index', repo] : ['index', repo, '--db', db];
  const first = runCliRaw(indexArgs, env);
  if (first.status !== 0) throw new Error(`색인 실패(${first.status}): ${indexArgs.join(' ')}\n${first.stderr}`);
  const firstSummary = JSON.parse(first.stdout);
  const ask = (...args: string[]) => runCli([...args, ...where], env);
  let fresh = 0;
  return {
    repo,
    ask,
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
    reindex: () => runCli(indexArgs, env),
    indexFresh: () => {
      const freshDb = join(work, `fresh-${++fresh}.db`);
      const summary = runCli(['index', repo, '--db', freshDb], env);
      return { summary, ask: (...args) => runCli([...args, '--db', freshDb], env) };
    },
    firstSummary,
    firstLog: first.stderr,
    git: (...args) => git(repo, ...args),
    commit: (message) => {
      git(repo, 'add', '-A');
      git(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
      return git(repo, 'rev-parse', 'HEAD');
    },
    restore: () => {
      git(repo, 'checkout', '--', '.');
      git(repo, 'clean', '-fdq');
    },
    dispose: () => rmSync(work, { recursive: true, force: true }),
  };
}

/** `test/expected/<fixture>/<file>`의 경로. */
export function expectedPath(fixture: string, file: string): string {
  return join(root, 'test', 'expected', fixture, file);
}

/** `test/expected/<fixture>/<file>`의 정답 JSON. */
export function expected(fixture: string, file: string): any {
  return JSON.parse(readFileSync(expectedPath(fixture, file), 'utf8'));
}

/**
 * 답에서 항목인데 정밀/추정(confidence)이나 출처(source)가 없는 곳의 경로를 모아요.
 * 항목: 목록(배열)에 든 객체, 답이 가리키는 심볼(symbol, target, trace의 from·to).
 * 예외(계약 문서에 적은 것): 집계(impact·check의 modules[]), 파일 지점(context의 file, impact의 파일 target,
 * trace의 파일 노드). 항목 안의 설명 객체(definition, at, via, representative)는 바깥 항목의 표시를 따라요.
 */
export function unmarked(answer: any): string[] {
  const bad: string[] = [];
  const isFilePoint = (o: any) => o.kind === 'file' || ('language' in o && !('kind' in o));
  const need = (o: any, path: string) => {
    if (!['precise', 'inferred'].includes(o.confidence) || typeof o.source !== 'string') bad.push(path);
  };
  const walk = (value: any, path: string, key: string) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v === 'object' && !Array.isArray(v) && key !== 'modules' && !(key === 'nodes' && isFilePoint(v))) {
          need(v, `${path}[${i}]`);
        }
        walk(v, `${path}[${i}]`, key);
      });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, k);
    }
  };
  for (const k of ['symbol', 'target', 'from', 'to']) {
    const o = answer[k];
    if (o && typeof o === 'object' && !isFilePoint(o)) need(o, k);
  }
  walk(answer, '', '');
  return bad;
}
