// scip-typescript를 저장소 하나에 돌리는 자식 프로세스.
// 사용: node typescript-runner.ts <작업.json>
//   작업.json: { root, output, positions, groups: [{ config: 설정 파일 절대 경로 | null, files: 절대 경로[] }] }
//
// scip-typescript의 명령줄을 쓰지 않고 그 안의 ProjectIndexer를 바로 불러요. 명령줄은 저장소 안의 tsconfig.json을 그대로
// 쓰거나(색인할 파일을 고를 수 없어요) 없으면 tsconfig.json을 저장소에 새로 써요(--infer-tsconfig). 둘 다 피하려고
// 색인할 파일과 컴파일러 설정을 여기서 만들어 넘겨요. 프로젝트 뿌리(심볼의 패키지와 경로를 정하는 곳)는 늘 저장소 뿌리예요.
// scip-typescript가 stdout에 진행 글을 써서 색인기 프로세스와 따로 돌려요(MCP stdio를 더럽히지 않게).
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Group {
  config: string | null;
  files: string[];
}

interface Job {
  root: string;
  /** SCIP 색인을 쓸 파일. */
  output: string;
  /** 파일마다 occurrence가 있는 자리('줄:열')를 JSON으로 쓸 파일. */
  positions: string;
  groups: Group[];
}

/**
 * scip-typescript가 쓰는 것과 같은 패키지를 불러요(같은 typescript, 같은 SCIP 정의). scip-typescript 폴더에서 Node가 찾는
 * 순서대로 node_modules를 훑고, 패키지의 진입 파일을 파일 경로로 불러요(exports가 require를 막는 ESM 전용 패키지도 있어서요).
 */
function locate(from: string, name: string): string {
  for (const dir of createRequire(from).resolve.paths(name) ?? []) {
    const pkg = join(dir, name);
    if (existsSync(join(pkg, 'package.json'))) return pkg;
  }
  throw new Error(`${name}을(를) 찾지 못했어요(${from})`);
}

async function importPackage(from: string, name: string): Promise<any> {
  const dir = locate(from, name);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const dot = meta.exports?.['.'];
  const entry = (typeof dot === 'string' ? dot : (dot?.import ?? dot?.default)) ?? meta.main ?? 'index.js';
  const mod = await import(pathToFileURL(join(dir, entry)).href);
  return mod.default && Object.keys(mod).length <= 2 ? mod.default : mod;
}

const scipDir = locate(fileURLToPath(import.meta.url), '@sourcegraph/scip-typescript');
const scipMain = join(scipDir, 'dist', 'src', 'main.js');
// scip-typescript가 쓰는 typescript(6.x)예요. code-atlas의 개발용 typescript(7.x, 타입 검사용)와 API가 달라서 타입을 붙이지 않아요.
const ts = await importPackage(scipMain, 'typescript');
const { ProjectIndexer } = await import(pathToFileURL(join(scipDir, 'dist', 'src', 'ProjectIndexer.js')).href);
const { create, toBinary } = await importPackage(scipMain, '@bufbuild/protobuf');
const { IndexSchema, MetadataSchema, TextEncoding, ToolInfoSchema } = await importPackage(scipMain, '@scip-code/scip');

const job = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Job;

/** 설정 파일이 없는 파일(순수 JavaScript 폴더 등)에 쓰는 컴파일러 설정. */
const DEFAULTS: Record<string, unknown> = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

/** 저장소의 tsconfig.json/jsconfig.json에서 컴파일러 설정만 읽어요. 읽지 못하면(extends가 설치되지 않은 패키지 등) 기본 설정. */
function optionsOf(config: string | null): Record<string, unknown> {
  if (config === null) return DEFAULTS;
  const read = ts.readConfigFile(config, (p: string) => ts.sys.readFile(p));
  if (read.error) return DEFAULTS;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, config.replace(/[\\/][^\\/]*$/, ''), undefined, config);
  return { ...DEFAULTS, ...parsed.options };
}

const out = openSync(job.output, 'w');
// occurrence가 있는 자리(지역 이름, 저장소 밖 이름 포함). 어댑터가 scip-typescript가 아무것도 잇지 못한 자리를 가릴 때 써요.
const positions: Record<string, string[]> = {};
const writeIndex = (index: { documents?: { relativePath: string; occurrences: { range: number[] }[] }[] }) => {
  for (const doc of index.documents ?? []) {
    const path = doc.relativePath.replaceAll('\\', '/');
    (positions[path] ??= []).push(...doc.occurrences.map((o) => `${o.range[0]}:${o.range[1]}`));
  }
  writeSync(out, toBinary(IndexSchema, index));
};
try {
  writeIndex(
    create(IndexSchema, {
      metadata: create(MetadataSchema, {
        projectRoot: pathToFileURL(job.root).toString(),
        textDocumentEncoding: TextEncoding.UTF8,
        toolInfo: create(ToolInfoSchema, { name: 'scip-typescript', version: '', arguments: [] }),
      }),
    }),
  );
  const cache = { sources: new Map(), parsedCommandLines: new Map(), indexedFiles: new Set(), sourceInfos: new Map() };
  for (const group of job.groups) {
    // 색인할 파일은 우리가 골라요. JavaScript도 읽고(allowJs), 아무것도 내보내지 않아요(noEmit).
    const options = { ...optionsOf(group.config), allowJs: true, noEmit: true, declaration: false, composite: false };
    const config = { options, fileNames: group.files, errors: [] };
    new ProjectIndexer(config, {
      cwd: job.root,
      projectRoot: job.root,
      projectDisplayName: group.config ?? job.root,
      writeIndex,
      progressBar: false,
      globalCaches: true,
      maxFileByteSizeNumber: 1024 * 1024,
      indexedProjects: new Set(),
    }, cache).index();
  }
} finally {
  closeSync(out);
}
writeFileSync(job.positions, JSON.stringify(positions));
