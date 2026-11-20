// Dart 정밀 어댑터: 저장소 안의 Dart 패키지마다 scip-dart를 돌리고 SCIP 색인을 사실로 옮겨요.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendFacts, emptyFacts, IndexerMissing, type Facts, type LanguageAdapter, type RepoInfo } from '../facts.ts';
import { run, runOrThrow } from '../run.ts';
import { scipToFacts } from '../scip/to-facts.ts';
import { refineDartFacts } from './dart-refine.ts';

/** 시험한 scip-dart 버전. README와 CI도 이 버전을 깔아요. */
const SCIP_DART_VERSION = '1.8.1';

export const SCIP_DART_INSTALL = `dart pub global activate scip_dart ${SCIP_DART_VERSION}`;

/** 저장소 안의 Dart 패키지 폴더(뿌리 기준, '' = 뿌리). 숨김 폴더(.으로 시작)와 build 폴더 안의 pubspec은 빼요. */
function dartPackages(repo: RepoInfo): string[] {
  if (repo.trackedFiles === null) return existsSync(join(repo.root, 'pubspec.yaml')) ? [''] : [];
  return repo.trackedFiles
    .filter((f) => f === 'pubspec.yaml' || f.endsWith('/pubspec.yaml'))
    .map((f) => f.slice(0, -'pubspec.yaml'.length).replace(/\/$/, ''))
    .filter((dir) => !dir.split('/').some((part) => part.startsWith('.') || part === 'build'));
}

function usesFlutter(pkgRoot: string): boolean {
  return /^\s+sdk:\s*flutter\s*$/m.test(readFileSync(join(pkgRoot, 'pubspec.yaml'), 'utf8'));
}

/**
 * scip-dart는 패키지 설정(.dart_tool/package_config.json)이 있어야 돌아요.
 * 없으면 pub get을 대신 돌리지 않고(네트워크를 쓰고 생성 파일을 만들어요) 할 일을 알려 줘요.
 */
function requirePackageConfig(pkgRoot: string): void {
  if (existsSync(join(pkgRoot, '.dart_tool', 'package_config.json'))) return;
  const tool = usesFlutter(pkgRoot) ? 'flutter' : 'dart';
  throw new Error(`패키지 설정이 없어요: ${pkgRoot}\n먼저 그 폴더에서 ${tool} pub get 을 돌려요.`);
}

/** SCIP 기술자 이름: 단순한 이름은 그대로, 나머지는 backtick으로 감싸요(scip-dart가 Linux에서 쓰는 꼴). */
const descriptorName = (segment: string) => (/^[\w+$-]+$/.test(segment) ? segment : `\`${segment}\``);

/**
 * scip-dart는 같은 심볼을 OS마다 다르게 적어요.
 *   Linux:   lib/src/`cart.dart`/Cart#add().     (경로 칸마다 기술자 하나)
 *   Windows: `lib\src\cart.dart`/Cart#add().     (경로 통째로 기술자 하나, 구분자 '\')
 * 심볼 열쇠가 OS마다 같도록 Windows 꼴을 Linux 꼴로 바꾸고, 경로의 '\'도 '/'로 바꿔요.
 * Dart 식별자와 패키지 이름에는 '\'가 없어서, '\'가 든 backtick 이름은 경로뿐이에요.
 */
const toLinuxForm = (s: string) =>
  s
    .replace(/`([^`]*\\[^`]*)`/g, (_, path: string) => path.split('\\').map(descriptorName).join('/'))
    .replaceAll('\\', '/');

/**
 * `part of 'a.dart';` 지시문은 scip-dart가 a.dart로 가는 import처럼 적어요. 하지만 part 파일은 a.dart와 한 라이브러리라
 * 기대는 방향이 아니에요(a.dart의 `part` 지시문이 이미 이어 줘요). 그대로 두면 라이브러리마다 서로 물린 파일 묶음이 생겨서 빼요.
 */
function dropPartOf(facts: Facts, readText: (path: string) => string | null): Facts {
  const lines = new Map<string, string[]>();
  const lineOf = (path: string, line: number) => {
    let text = lines.get(path);
    if (!text) lines.set(path, (text = (readText(path) ?? '').split('\n')));
    return text[line] ?? '';
  };
  facts.relations = facts.relations.filter(
    (r) => !(r.kind === 'import' && 'path' in r.to && /^\s*part\s+of\b/.test(lineOf(r.from.path, r.from.range.startLine))),
  );
  return facts;
}

/** 저장소 기준 경로의 소스 글. 없으면 null. */
function readSource(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

export const dartAdapter: LanguageAdapter = {
  name: 'scip-dart',
  language: 'dart',
  install: SCIP_DART_INSTALL,

  applies: (repo) => dartPackages(repo).length > 0,

  async index(repo, workDir) {
    const probe = run('dart', ['pub', 'global', 'run', 'scip_dart', '--version']);
    if (!probe.ok) {
      throw new Error(`scip-dart를 찾지 못했어요. 설치: ${SCIP_DART_INSTALL}\n${probe.stderr}`);
    }
    const facts = emptyFacts();
    for (const [i, pkg] of dartPackages(repo).entries()) {
      const pkgRoot = resolve(repo.root, pkg);
      requirePackageConfig(pkgRoot);
      const out = join(workDir, `dart-${i}.scip`);
      // 경로는 절대 경로로 줘요. './'로 주면 scip-dart 1.8.1이 패키지 전체를 '중첩 패키지'로 보고 0개를 색인해요.
      runOrThrow('dart', ['pub', 'global', 'run', 'scip_dart', '-o', out, pkgRoot], pkgRoot);
      const raw = scipToFacts(out, { source: this.name, language: this.language, pathPrefix: pkg, normalize: toLinuxForm });
      const readText = (path: string) => readSource(repo.root, path);
      appendFacts(facts, dropPartOf(refineDartFacts(raw, { pathPrefix: pkg, readText }), readText));
    }
    return facts;
  },
};
