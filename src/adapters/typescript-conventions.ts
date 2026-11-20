// JavaScript/TypeScript 관례: 어느 파일이 이 언어의 파일이고, 어느 것이 생성된 코드·빌드 산출물이고, 어느 것이 테스트인지.
// 정밀 어댑터(typescript.ts)와 추정 층의 규칙(src/inferred/typescript.ts)이 같은 규칙을 써요.
import { posix } from 'node:path';
import type { FileRole } from '../facts.ts';

/** JavaScript/TypeScript 파일의 꼬리. */
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

/** 이 언어의 파일인지(확장자). */
export function isJsTsFile(path: string): boolean {
  return [...TS_EXTENSIONS, ...JS_EXTENSIONS].some((e) => path.endsWith(e));
}

/** 파일의 언어 이름: TypeScript 파일이면 'typescript', 아니면 'javascript'. */
export function jsTsLanguage(path: string): 'typescript' | 'javascript' {
  return TS_EXTENSIONS.some((e) => path.endsWith(e)) ? 'typescript' : 'javascript';
}

/** Tree-sitter 문법 이름: .tsx는 tsx, TypeScript는 typescript, JavaScript(JSX 포함)는 javascript. */
export function jsTsGrammar(path: string): string {
  if (path.endsWith('.tsx')) return 'tsx';
  return jsTsLanguage(path) === 'typescript' ? 'typescript' : 'javascript';
}

/** 패키지 뿌리(package.json이 있는 폴더, 없으면 저장소 뿌리) 바로 아래의 빌드 산출물 폴더. */
const OUTPUT_DIRS = ['dist/', 'build/', 'out/', 'coverage/'];
/** 생성기가 파일 머리에 다는 표시. */
const GENERATED_MARK = /@generated\b|GENERATED CODE - DO NOT MODIFY|This file (?:was|is) (?:auto-?)?generated/i;
/** 테스트 폴더 이름(경로 어디에 있어도). */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', '__mocks__']);

/**
 * 생성된 코드나 빌드 산출물인지.
 * @param path 저장소 기준 경로
 * @param head 파일 머리 글(앞 1000자면 충분해요). 읽지 못하면 빈 글.
 * @param packageRoots package.json이 있는 폴더들(저장소 기준, 뿌리는 '')
 */
export function isGeneratedJsTs(path: string, head: string, packageRoots: ReadonlySet<string>): boolean {
  const parts = path.split('/');
  if (parts.includes('node_modules')) return true;
  if (path.endsWith('.min.js') || path.endsWith('.bundle.js')) return true;
  // 가장 가까운 패키지 뿌리 기준으로 dist/ 등을 봐요. 패키지가 없으면 저장소 뿌리 기준이에요.
  let dir = posix.dirname(path);
  while (dir !== '.' && !packageRoots.has(dir)) dir = posix.dirname(dir);
  const inPackage = dir === '.' ? path : path.slice(dir.length + 1);
  if (OUTPUT_DIRS.some((d) => inPackage.startsWith(d))) return true;
  return GENERATED_MARK.test(head.slice(0, 1000));
}

/** 테스트 파일인지: test/·tests/·__tests__/·spec/ 폴더 아래이거나 이름이 *.test.*·*.spec.*이면 test. */
export function jsTsRole(path: string): FileRole {
  const parts = path.split('/');
  const name = parts.at(-1)!;
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p))) return 'test';
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? 'test' : 'app';
}

/** 저장소 파일 목록에서 package.json이 있는 폴더(뿌리는 ''). node_modules 안은 빼요. */
export function packageRootsOf(files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f !== 'package.json' && !f.endsWith('/package.json')) continue;
    if (f.split('/').includes('node_modules')) continue;
    out.add(f === 'package.json' ? '' : f.slice(0, -'/package.json'.length));
  }
  return out;
}
