// JavaScript/TypeScript 정밀 어댑터: 저장소의 JS/TS 파일을 scip-typescript로 한 번에 색인하고 SCIP 색인을 사실로 옮겨요.
//
// - scip-typescript는 code-atlas의 npm 의존성이에요(`npm ci`로 함께 깔려요). 명령줄 대신 그 안의 ProjectIndexer를
//   자식 프로세스(typescript-runner.ts)에서 불러요: 색인할 파일을 우리가 고르고, 설정 파일이 없는 폴더도 저장소를 건드리지 않고 색인해요.
// - 파일마다 가장 가까운 tsconfig.json/jsconfig.json의 컴파일러 설정을 쓰고, 없으면 기본 설정(allowJs 등)이에요.
// - scip-typescript가 주지 않는 것은 이 어댑터가 채워요(typescript-refine.ts): 사용처의 종류, 이름을 가져오기만 하는 자리 빼기,
//   그리고 scip-typescript가 아무것도 잇지 못한 이름 자리(JSDoc의 @implements·@type 등)는 추정 층으로 이어 추정으로 붙여요.
import { HEAD_LENGTH } from './conventions.ts';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexerMissing, type LanguageAdapter, type RepoInfo } from '../facts.ts';
import { listRepoFiles, repoView, type RepoView } from '../inferred/layer.ts';
import { typescriptInferred } from '../inferred/typescript.ts';
import { scipToFacts } from '../scip/to-facts.ts';
import { refineTypeScriptFacts } from './typescript-refine.ts';

/** 시험한 scip-typescript 버전. package.json도 이 버전에 묶어 둬요. */
export const SCIP_TYPESCRIPT_VERSION = '0.6.2';
export const SCIP_TYPESCRIPT_INSTALL = `code-atlas 폴더에서 npm ci (의존성 @sourcegraph/scip-typescript@${SCIP_TYPESCRIPT_VERSION})`;

const RUNNER = fileURLToPath(new URL('./typescript-runner.ts', import.meta.url));
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

/** scip-typescript가 깔려 있는지(code-atlas의 node_modules에서 찾아요). */
function scipTypeScriptInstalled(): boolean {
  const require = createRequire(import.meta.url);
  return (require.resolve.paths('@sourcegraph/scip-typescript') ?? []).some((dir) => {
    try {
      readFileSync(join(dir, '@sourcegraph', 'scip-typescript', 'package.json'));
      return true;
    } catch {
      return false;
    }
  });
}

/** 색인할 JS/TS 파일(생성된 코드, 빌드 산출물, node_modules 빼고). */
function sourceFiles(view: RepoView): string[] {
  return [...view.files]
    .filter((p) => typescriptInferred.owns(p) && !typescriptInferred.excluded(p, view.read(p)?.slice(0, HEAD_LENGTH) ?? '', view))
    .sort();
}

/**
 * 파일마다 가장 가까운 설정 파일(tsconfig.json, 없으면 jsconfig.json)로 묶어요. 설정 파일이 없는 파일은 null 묶음이에요.
 * 설정 파일에서는 컴파일러 설정만 쓰고, 색인할 파일은 늘 우리가 골라요(설정의 include와 상관없이 저장소의 파일 전부).
 */
function groupByConfig(files: string[], all: ReadonlySet<string>): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const f of files) {
    let config: string | null = null;
    for (let dir = posix.dirname(f); config === null; dir = posix.dirname(dir)) {
      const prefix = dir === '.' ? '' : `${dir}/`;
      config = CONFIG_NAMES.map((n) => prefix + n).find((c) => all.has(c)) ?? null;
      if (dir === '.') break;
    }
    const list = groups.get(config) ?? [];
    list.push(f);
    groups.set(config, list);
  }
  return groups;
}

export const typescriptAdapter: LanguageAdapter = {
  name: 'scip-typescript',
  language: 'typescript',
  install: SCIP_TYPESCRIPT_INSTALL,

  applies: (repo) => {
    const view = repoView(repo, listRepoFiles(repo));
    return sourceFiles(view).length > 0;
  },

  async index(repo: RepoInfo, workDir: string) {
    if (!scipTypeScriptInstalled()) {
      throw new IndexerMissing(`scip-typescript를 찾지 못했어요.`, SCIP_TYPESCRIPT_INSTALL);
    }
    const files = listRepoFiles(repo);
    const view = repoView(repo, files);
    const chosen = sourceFiles(view);
    const abs = (p: string) => join(repo.root, p).replaceAll('\\', '/');
    const job = {
      root: repo.root.replaceAll('\\', '/'),
      output: join(workDir, 'typescript.scip'),
      positions: join(workDir, 'typescript-positions.json'),
      groups: [...groupByConfig(chosen, files)].map(([config, list]) => ({ config: config === null ? null : abs(config), files: list.map(abs) })),
    };
    const jobFile = join(workDir, 'typescript-job.json');
    writeFileSync(jobFile, JSON.stringify(job));
    // 이 프로세스의 Node 설정(--import 등, 테스트의 네트워크 차단 장치 포함)을 자식에게도 줘요.
    const r = spawnSync(process.execPath, [...process.execArgv, RUNNER, jobFile], {
      cwd: repo.root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`scip-typescript 실패(${r.status}): ${(r.stderr || r.stdout || String(r.error)).slice(0, 2000)}`);
    const positions = JSON.parse(readFileSync(job.positions, 'utf8')) as Record<string, string[]>;
    const raw = scipToFacts(job.output, {
      source: this.name,
      language: this.language,
      pathPrefix: '',
      normalize: (s) => s.replaceAll('\\', '/'),
    });
    return refineTypeScriptFacts(raw, { repo, view, positions });
  },
};
