// 코드 지도 화면에 넣을 자료를 그래프에서 뽑아요.
// 구조 계산(서로 물린 파일, 흐름을 거스르는 import, 층, 리뷰 후보)은 check 질의의 답을 그대로 써요. 여기서 다시 계산하지 않아요.
// 그래프에 없는 것은 두 가지뿐이에요: 파일의 줄 수(작업 트리의 파일을 읽어요)와 최근 90일 변경 횟수(git log).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compareText } from '../answer.ts';
import type { GraphStore } from '../graph/store.ts';
import { repoModules } from '../modules.ts';
import { check, scopedImports, stronglyConnected } from '../query/check.ts';
import { run } from '../run.ts';
import { externalPackageOf } from './packages.ts';

/** 파일 찾아보기의 한 줄. 칸 이름이 짧은 건 자료가 HTML에 그대로 들어가서예요. */
export interface MapFile {
  /** 경로(저장소 뿌리 기준). */
  p: string;
  /** 모듈. */
  m: string;
  /** 줄 수. */
  l: number;
  /** 최근 90일 동안 이 파일을 건드린 커밋 수(병합 커밋 제외). */
  c: number;
  /** 이 파일을 가져다 쓰는 지도 안 파일 수. */
  i: number;
  /** 이 파일이 가져다 쓰는 지도 안 파일 수. */
  o: number;
  /** 테스트: 2 = 테스트 파일이 직접 import, 1 = 테스트 파일이 이 파일의 이름을 다른 파일(barrel 등)을 거쳐 씀, 0 = 없음. */
  t: 0 | 1 | 2;
}

export interface MapData {
  title: string;
  repo: string;
  /** 색인 기준 커밋(짧은 꼴)과 전체. git 저장소가 아니면 null. */
  head: string | null;
  commit: string | null;
  /** 그릴 때의 브랜치. 이름 없는 HEAD면 'HEAD', git 저장소가 아니면 null. */
  branch: string | null;
  /** 색인한 날(YYYY-MM-DD). */
  date: string;
  /** 모든 파일 경로가 함께 가진 앞부분(예: 'lib/'). 화면에서 줄여 보여요. */
  root: string;
  /** 더 줄여 보여 줄 앞부분(모듈 규칙의 `{module}` 앞, 예: 'lib/features/'). */
  compact: string[];
  /** 모듈 규칙(읽는 법에 그대로 적어요). */
  rules: { path: string; module?: string }[];
  files: MapFile[];
  modules: { name: string; files: number; depth: number; lines: number; churn: number; untested: number }[];
  /** 모듈 사이 import: "a>b" → [가져다 쓰는 파일, 가져오는 파일] 목록. */
  medges: Record<string, [string, string][]>;
  /** 흐름을 거스르는 모듈 간선("a>b"). */
  backEdges: string[];
  /** 흐름을 거스르는 import와 허용 목록에 든 것인지(check의 backwardImports). */
  back: { from: string; to: string; allowed: boolean }[];
  /** 위(가져다 쓰는 쪽)에서 아래로 세운 모듈 순서(check의 modules). */
  order: string[];
  /** 서로 도는 모듈 묶음에 든 모듈. */
  cycleMods: string[];
  /** check의 minimal: 흐름을 거스르는 import 수가 증명된 최소인지. */
  minimal: boolean;
  cycles: { files: string[]; mods: string[]; edges: [string, string][] }[];
  /** 리뷰 후보(check의 reviewCandidates)와 화면의 꼬리표·메모. */
  reach: { t: string; module: string; from: string[]; label: string | null; note: string | null }[];
  /** 공용 모듈(설정의 shared에서 composers를 뺀 것). 리뷰 후보 메모에 적어요. */
  shared: string[];
  /** 허용 목록을 읽은 파일(설정의 allowlist[].file). */
  allowFiles: string[];
  /** 띠로 그릴 모듈과 메모. */
  bands: Record<string, string>;
  /** 외부 패키지 → 그 패키지를 가리키는 지도 안 파일. */
  pkgUse: Record<string, string[]>;
  /** 외부 패키지의 보일 이름(설정에 적은 것만). */
  pkgNames: Record<string, string>;
  select: string | null;
}

const git = (root: string, args: string[]) => {
  const r = run('git', args, root);
  return r.ok ? r.stdout : null;
};

/** 경로들이 함께 가진 폴더 앞부분('/'로 끝나요). 없으면 ''. */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return '';
  let prefix = paths[0]!.slice(0, paths[0]!.lastIndexOf('/') + 1);
  for (const p of paths) while (!p.startsWith(prefix)) prefix = prefix.slice(0, prefix.lastIndexOf('/', prefix.length - 2) + 1);
  return prefix;
}

/** 그래프와 저장소 설정으로 코드 지도 자료를 만들어요. */
export function codeMapData(store: GraphStore, configPath?: string): MapData {
  const meta = store.meta();
  const root = meta.repoRoot;
  const { config, moduleOf } = repoModules(store, configPath);
  const checked = check(store, Number.MAX_SAFE_INTEGER, configPath);
  const { files: paths, imports } = scopedImports(store, moduleOf);
  const inScope = new Set(paths);
  const mod = (p: string) => moduleOf(p)!;

  // 파일마다: 지도 안에서 가져다 쓰는 곳·쓰이는 곳, 테스트, 줄 수, 변경 횟수.
  const outs = new Map<string, number>();
  const ins = new Map<string, number>();
  for (const i of imports) {
    outs.set(i.from, (outs.get(i.from) ?? 0) + 1);
    ins.set(i.to, (ins.get(i.to) ?? 0) + 1);
  }
  const churn = new Map<string, number>();
  const log = git(root, ['log', '--since=90 days ago', '--no-merges', '--name-only', '--format=%x00']) ?? '';
  for (const line of log.split('\n')) {
    const file = line.trim();
    if (inScope.has(file)) churn.set(file, (churn.get(file) ?? 0) + 1);
  }
  const testOf = (p: string): 0 | 1 | 2 => {
    if (store.importersOf(p).some((l) => l.role === 'test')) return 2;
    if (store.usersOf(p).some((l) => l.role === 'test')) return 1;
    return 0;
  };
  const files: MapFile[] = paths.map((p) => ({
    p,
    m: mod(p),
    // 끝 줄바꿈도 한 줄로 세요(지금까지의 코드 지도와 같은 셈).
    l: readFileSync(join(root, p), 'utf8').split('\n').length,
    c: churn.get(p) ?? 0,
    i: ins.get(p) ?? 0,
    o: outs.get(p) ?? 0,
    t: testOf(p),
  }));

  // 모듈 사이 import와 서로 도는 모듈 묶음.
  const medges: Record<string, [string, string][]> = {};
  for (const i of imports) {
    const a = mod(i.from);
    const b = mod(i.to);
    if (a !== b) (medges[`${a}>${b}`] ??= []).push([i.from, i.to]);
  }
  const moduleNames = checked.modules.map((m) => m.name);
  const moduleGroups = stronglyConnected([...moduleNames].sort(compareText), (m) =>
    moduleNames.filter((x) => medges[`${m}>${x}`]),
  );
  const backward = checked.backwardImports.items;
  const backEdges = [...new Set(backward.map((b) => `${b.fromModule}>${b.toModule}`))];

  const modules = checked.modules.map((m) => {
    const own = files.filter((f) => f.m === m.name);
    return {
      name: m.name,
      files: own.length,
      depth: m.layer,
      lines: own.reduce((sum, f) => sum + f.l, 0),
      churn: own.reduce((sum, f) => sum + f.c, 0),
      untested: own.filter((f) => !f.t).length,
    };
  });

  // 외부 패키지가 닿는 파일. 저장소 자신의 패키지(색인에서 빠진 생성 파일 등)는 빼요.
  const ownPackages = new Set(
    store
      .definitions()
      .map((d) => externalPackageOf(d.key, { anySymbol: true }))
      .filter((p): p is string => p !== null),
  );
  const found: Record<string, Set<string>> = {};
  for (const { path, key } of store.externalRefs()) {
    if (!inScope.has(path)) continue;
    const pkg = externalPackageOf(key);
    if (pkg && !ownPackages.has(pkg)) (found[pkg] ??= new Set()).add(path);
  }
  const wanted = config.map.packages
    ? Object.keys(config.map.packages)
    : Object.keys(found).sort((a, b) => found[b]!.size - found[a]!.size || compareText(a, b));
  const pkgUse = Object.fromEntries(wanted.map((pkg) => [pkg, [...(found[pkg] ?? [])].sort(compareText)]));

  // 리뷰 후보의 꼬리표와 메모.
  const notes = config.map.reviewNotes ?? [];
  const reach = checked.reviewCandidates.items.map((r) => {
    const note = notes.find((n) => n.modules.includes(r.module));
    return { t: r.target, module: r.module, from: r.from, label: note?.label ?? null, note: note?.note ?? null };
  });

  const composers = new Set(config.composers);
  const bands =
    config.map.bands ?? Object.fromEntries(config.shared.filter((m) => !composers.has(m) && moduleNames.includes(m)).map((m) => [m, '']));

  const commit = meta.commit;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? null;
  return {
    title: config.map.title ?? `${basename(root)} 코드 지도`,
    repo: basename(root),
    head: commit ? commit.slice(0, 7) : null,
    commit,
    branch,
    date: meta.indexedAt.slice(0, 10),
    root: commonDir(paths),
    compact: config.modules
      .filter((r) => r.path.includes('{module}'))
      .map((r) => r.path.slice(0, r.path.indexOf('{module}')))
      .filter((p) => p.endsWith('/')),
    rules: config.modules,
    files,
    modules,
    medges,
    backEdges,
    back: backward.map((b) => ({ from: b.from, to: b.to, allowed: b.allowed })),
    order: moduleNames,
    cycleMods: moduleGroups.filter((g) => g.length > 1).flat(),
    minimal: checked.summary.minimal,
    cycles: checked.cycles.items.map((c) => ({ files: c.files.items, mods: c.modules, edges: c.imports.items })),
    reach,
    shared: config.shared.filter((m) => !composers.has(m)),
    allowFiles: config.allowlist.flatMap((a) => (a.file ? [a.file] : [])),
    bands,
    pkgUse,
    pkgNames: config.map.packages ?? {},
    select: config.map.select ?? backward[0]?.toModule ?? null,
  };
}
