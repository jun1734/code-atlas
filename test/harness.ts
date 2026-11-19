// 도구 호출 경계의 테스트 틀: 예제 저장소를 임시 git 저장소로 복사해 색인하고,
// 명령줄 도구와 MCP 서버를 실제 프로세스로 불러 JSON 답을 받아요. 내부 모듈은 부르지 않아요.
// 모든 도구 프로세스는 네트워크 차단 장치(test/no-network.ts)를 단 채로 돌아요.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
/** 네트워크를 쓰려 하면 프로세스를 멈추는 장치. 모든 도구 프로세스에 `--import`로 달아요. */
export const NO_NETWORK = pathToFileURL(join(root, 'test', 'no-network.ts')).href;
/** 차단 장치가 네트워크 시도를 잡으면 이 종료 코드로 끝나요. */
export const NETWORK_EXIT = 97;

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 명령줄 도구를 돌려 종료 코드와 출력을 그대로 받아요. */
export function runCliRaw(args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, ['--import', NO_NETWORK, cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
    env: { ...(process.env as Record<string, string>), ...opts.env },
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
  /** 사본의 작업 트리를 커밋 상태로 되돌려요. */
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
  cpSync(join(root, 'test', 'fixtures', name), repo, {
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
  if (existsSync(join(repo, 'pubspec.yaml'))) {
    execSync('dart pub get --enforce-lockfile', { cwd: repo, stdio: 'ignore' });
  }
  let ask: (...args: string[]) => any;
  if (opts.home) {
    const env = { CODE_ATLAS_HOME: opts.home };
    runCli(['index', repo], env);
    ask = (...args) => runCli([...args, '--repo', repo], env);
  } else {
    const db = join(work, 'atlas.db');
    runCli(['index', repo, '--db', db]);
    ask = (...args) => runCli([...args, '--db', db]);
  }
  return {
    repo,
    ask,
    gitStatus: () => git(repo, 'status', '--porcelain'),
    head: () => git(repo, 'rev-parse', 'HEAD'),
    append: (path, text) => appendFileSync(join(repo, path), text),
    restore: () => {
      git(repo, 'checkout', '--', '.');
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
