// Dart 정밀 어댑터: 저장소 안의 Dart 패키지마다 scip-dart를 돌리고 SCIP 색인을 사실로 옮겨요.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Facts, LanguageAdapter, RepoInfo } from '../facts.ts';
import { run, runOrThrow } from '../run.ts';
import { scipToFacts } from '../scip/to-facts.ts';

/** 시험한 scip-dart 버전. README와 CI도 이 버전을 깔아요. */
export const SCIP_DART_VERSION = '1.8.1';

export const SCIP_DART_INSTALL = `dart pub global activate scip_dart ${SCIP_DART_VERSION}`;

/** 저장소 안의 Dart 패키지 폴더(뿌리 기준, '' = 뿌리). 생성물 폴더 안의 pubspec은 빼요. */
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
 * 패키지 설정(.dart_tool/package_config.json)이 없으면 pub get을 돌려요.
 * pubspec.lock이 있으면 --enforce-lockfile로 돌려 추적 파일인 lock을 바꾸지 않아요.
 */
function ensurePackageConfig(pkgRoot: string): void {
  if (existsSync(join(pkgRoot, '.dart_tool', 'package_config.json'))) return;
  const tool = usesFlutter(pkgRoot) ? 'flutter' : 'dart';
  const args = ['pub', 'get'];
  if (existsSync(join(pkgRoot, 'pubspec.lock'))) args.push('--enforce-lockfile');
  runOrThrow(tool, args, pkgRoot);
}

/**
 * scip-dart는 Windows에서 경로와 심볼에 '\'를 넣어요('`lib\src\a.dart`/').
 * 심볼 열쇠가 OS마다 달라지지 않게 '/'로 바꿔요. Dart 식별자에는 '\'가 없어요.
 */
const toSlash = (s: string) => s.replaceAll('\\', '/');

export const dartAdapter: LanguageAdapter = {
  name: 'scip-dart',
  language: 'dart',

  applies: (repo) => dartPackages(repo).length > 0,

  async index(repo, workDir) {
    const probe = run('dart', ['pub', 'global', 'run', 'scip_dart', '--version']);
    if (!probe.ok) {
      throw new Error(`scip-dart를 찾지 못했어요. 설치: ${SCIP_DART_INSTALL}\n${probe.stderr}`);
    }
    const facts: Facts = { files: [], symbols: [], relations: [] };
    for (const [i, pkg] of dartPackages(repo).entries()) {
      const pkgRoot = resolve(repo.root, pkg);
      ensurePackageConfig(pkgRoot);
      const out = join(workDir, `dart-${i}.scip`);
      // 경로는 절대 경로로 줘요. './'로 주면 scip-dart 1.8.1이 패키지 전체를 '중첩 패키지'로 보고 0개를 색인해요.
      runOrThrow('dart', ['pub', 'global', 'run', 'scip_dart', '-o', out, pkgRoot], pkgRoot);
      const part = scipToFacts(out, { source: this.name, language: this.language, pathPrefix: pkg, normalize: toSlash });
      facts.files.push(...part.files);
      facts.symbols.push(...part.symbols);
      facts.relations.push(...part.relations);
    }
    return facts;
  },
};
