// detect_changes: 작업 트리의 diff(또는 두 커밋 사이)가 건드린 이름과 그 영향 범위, 닿는 모듈과 테스트,
// 이 변경으로 새로 생긴 순환과 경계 위반.
//
// - 바뀐 줄은 git이 알려 줘요(src/diff.ts). 줄을 이름으로 옮길 때는 정의 전체(본문 포함)의 줄 범위를 써서,
//   바뀐 줄을 품는 가장 안쪽 이름이 건드린 이름이에요. 자리만 밀린 이름은 건드리지 않은 거예요.
// - "바꾸기 전"은 base 커밋을 따로 색인한 것(src/snapshot.ts), "바꾼 뒤"는 작업 트리면 저장소 색인(낡았으면 다시 색인),
//   커밋이면 그 커밋의 색인이에요. 지운 이름의 영향은 바꾸기 전 그래프에서, 나머지는 바꾼 뒤 그래프에서 찾아요(impact와 같은 탐색).
// - 구조(순환, 흐름을 거스르는 import)는 양쪽에 check를 돌려 비교해요. 규칙(저장소 설정)은 양쪽 모두 지금 저장소의 것이에요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { compareText, cut, DEFAULT_LIMIT, type Page, type Sourced, sourcedOf } from '../answer.ts';
import { diffFiles, type FileDiff, type LineSpan, resolveCommit } from '../diff.ts';
import type { FileRole, SymbolKind } from '../facts.ts';
import { isStale } from '../freshness.ts';
import { type ExtentRow, GraphStore } from '../graph/store.ts';
import { Graph, nodeId, type NodeId } from '../graph/traverse.ts';
import { indexRepo } from '../indexer.ts';
import { type ModuleOf, repoModules } from '../modules.ts';
import type { QueryDef } from '../queries.ts';
import { CONFIG_PARAM } from '../repo-config.ts';
import { indexCommit } from '../snapshot.ts';
import { type BackwardImportItem, check, type CheckBody, type CycleItem } from './check.ts';
import { byPlace, DEFAULT_DEPTH, DEFAULT_HOT_USES, type ImpactItem, type ImpactScope, reachImpact } from './impact.ts';

export type Change = 'added' | 'removed' | 'modified' | 'moved';

/** 이름 하나(또는 새로 생기거나 지우거나 옮긴 파일 하나)의 영향 범위 요약. 항목은 답의 affected에서 from으로 골라 봐요. */
export interface ChangeImpact {
  affected: number;
  /** 거리 → 영향 받는 곳의 수. */
  byDistance: Record<string, number>;
  moreBeyondDepth: boolean;
  /** 영향 받는 곳 가운데 테스트 파일에 있는 것. */
  tests: number;
}

/** 이 변경이 건드린 이름. 파일 자체가 생기거나 지워지거나 옮겨졌으면 그 파일(kind: 'file')도 하나로 나와요. */
export interface ChangedItem extends Sourced {
  /** 이름이면 바깥 타입을 붙인 이름, 파일이면 경로. */
  name: string;
  kind: SymbolKind;
  /** 지운 것은 바꾸기 전 경로, 나머지는 바꾼 뒤 경로. */
  path: string;
  /** 정의가 있는 줄(1부터). 파일이면 없어요. */
  line?: number;
  change: Change;
  /** 파일을 옮겼으면 옮기기 전 경로. */
  movedFrom?: string;
  module: string | null;
  role: FileRole;
  impact: ChangeImpact;
}

/** 영향 받는 곳 하나(impact의 항목)와, 어느 바뀐 이름에서 닿았는지. */
export interface AffectedItem extends ImpactItem {
  /** 이곳에 닿은 바뀐 이름(changes의 name). */
  from: string[];
  /** 이곳 자체도 이 변경이 건드렸는지(바뀐 이름이거나, 파일이면 바뀐 파일). false인 곳이 고치지 않은 채 남은 영향이에요. */
  changed: boolean;
}

export interface ChangedTestFile extends Sourced {
  path: string;
  /** 영향 받는 곳 가운데 가장 가까운 거리. 테스트 파일 자체를 고쳤으면 0. */
  distance: number;
}

/** 모듈 하나에 든 바뀐 이름과 영향 받는 곳의 수. */
export interface ChangeModule {
  module: string | null;
  changed: number;
  affected: number;
  /** 영향 받는 곳 가운데 테스트 파일에 있는 것. */
  tests: number;
}

export interface IntroducedCycle extends CycleItem {
  /** new: 바꾸기 전에는 어느 묶음에도 없던 파일들. changed: 이미 있던 묶음이 커지거나 바뀐 것. */
  status: 'new' | 'changed';
}

export interface IntroducedViolation extends BackwardImportItem {
  /** import 자체가 이 변경으로 생겼는지. false면 이미 있던 import가 모듈 순서가 바뀌며 흐름을 거스르게 된 거예요. */
  newImport: boolean;
}

export interface DetectChangesBody {
  [key: string]: unknown;
  /** 비교 기준 커밋. */
  base: { ref: string; commit: string };
  /** 바꾼 쪽. ref와 commit이 null이면 작업 트리(커밋하지 않은 것과 추적하지 않는 새 파일 포함)예요. */
  head: { ref: string | null; commit: string | null };
  /** 작업 트리를 보려고 저장소 색인을 다시 했는지. */
  reindexed: boolean;
  config: string | null;
  summary: {
    /** 바뀐 파일 가운데 색인된(어느 언어 어댑터가 읽은) 것. */
    files: Record<Change, number>;
    names: Record<Change, number>;
    depth: number;
    /** 영향 받는 곳(모든 바뀐 이름을 합쳐 겹치지 않게). */
    affected: number;
    moreBeyondDepth: boolean;
    modules: number;
    tests: number;
    newCycles: number;
    newViolations: number;
  };
  /** 건드린 이름. 경로, 줄, 이름 순. */
  changes: Page<ChangedItem>;
  /** 영향 받는 곳. 거리, 경로, 줄, 이름 순. 같은 곳에 여러 바뀐 이름이 닿으면 가장 가까운 거리로 하나예요. */
  affected: Page<AffectedItem>;
  /** 바뀐 이름과 영향 받는 곳이 든 모듈. 바뀐 것이 많은 모듈부터. 모듈 수만큼이라 자르지 않아요. */
  modules: ChangeModule[];
  /** 돌려 볼 테스트 파일: 고친 테스트 파일(거리 0)과 영향 범위에 걸린 테스트 파일. 거리, 경로 순. */
  tests: Page<ChangedTestFile>;
  /** 이 변경으로 생긴 구조 문제. 이미 있던 것은 개수만, 없어진 것은 resolved로 세요. */
  structure: {
    cycles: { introduced: Page<IntroducedCycle>; existing: number; resolved: number };
    /** 흐름을 거스르는 import 가운데 허용 목록에 없는 것(check의 새 위반). */
    violations: { introduced: Page<IntroducedViolation>; existing: number; resolved: number };
  };
}

export interface DetectChangesOptions {
  base: string;
  head?: string;
  depth: number;
  limit: number;
  hotUses: number;
  config?: string;
  /** 저장소 색인 파일. 다시 색인하거나 커밋 색인을 그 옆에 둘 때 써요. */
  db: string;
}

/** 목록을 자르지 않고 받을 때 check에 주는 limit. */
const ALL = Number.MAX_SAFE_INTEGER;

export async function detectChanges(store: GraphStore, opts: DetectChangesOptions): Promise<DetectChangesBody> {
  const root = store.meta().repoRoot;
  const baseCommit = resolveCommit(root, opts.base);
  const headCommit = opts.head === undefined ? null : resolveCommit(root, opts.head);
  const diffs = diffFiles(root, baseCommit, headCommit);

  // 바꾼 뒤: 작업 트리면 저장소 색인(낡았으면 다시 색인), 커밋이면 그 커밋의 색인.
  let reindexed = false;
  const opened: GraphStore[] = [];
  const openCommit = async (commit: string) => {
    const s = GraphStore.openExisting(await indexCommit(root, opts.db, commit))!;
    opened.push(s);
    return s;
  };
  try {
    let after = store;
    if (headCommit === null) {
      if (isStale(store.meta()) === true) {
        await indexRepo(root, opts.db);
        reindexed = true;
      }
    } else {
      after = await openCommit(headCommit);
    }
    // 바뀐 것이 없으면 바꾸기 전 색인을 만들지 않아요.
    const before = diffs.length > 0 ? await openCommit(baseCommit) : after;

    const { config, moduleOf } = repoModules(store, opts.config, root);
    const found = changedNames(diffs, before, after);
    const scope = (s: GraphStore): ImpactScope => ({
      graph: Graph.load(s),
      moduleOf,
      counts: s.useCounts(),
      hotUses: opts.hotUses,
      depth: opts.depth,
    });
    const afterScope = scope(after);
    const beforeScope = found.some((f) => f.change === 'removed') ? scope(before) : afterScope;

    // 바뀐 것마다 영향 범위, 그리고 모두 합친 영향 받는 곳.
    const changedPlaces = new Set(found.map((f) => placeKey(f.path, f.kind, f.name)));
    for (const d of diffs) for (const p of [d.oldPath, d.newPath]) if (p) changedPlaces.add(placeKey(p, 'file', p));
    const merged = new Map<string, AffectedItem>();
    let moreBeyondDepth = false;
    const changes: ChangedItem[] = found.map((f) => {
      const s = f.change === 'removed' ? beforeScope : afterScope;
      // 이름은 그 안의 것(멤버, 생성자)과 함께 출발해요(impact와 같아요). 파일은 그 파일 노드만(그 안의 이름은 따로 나와요).
      const starts = f.kind === 'file' ? f.starts : s.graph.members(f.starts[0]!);
      const { items, moreBeyondDepth: more } = reachImpact(s, starts);
      moreBeyondDepth ||= more;
      for (const item of items) {
        const k = placeKey(item.path, item.kind, item.name);
        const had = merged.get(k);
        if (!had || item.distance < had.distance) {
          merged.set(k, { ...item, from: had?.from ?? [], changed: changedPlaces.has(k) });
        }
        const m = merged.get(k)!;
        if (!m.from.includes(f.name)) m.from.push(f.name);
      }
      const byDistance: Record<string, number> = {};
      for (const item of items) byDistance[item.distance] = (byDistance[item.distance] ?? 0) + 1;
      const { starts: _starts, ...rest } = f;
      return {
        ...rest,
        module: moduleOf(f.path),
        impact: { affected: items.length, byDistance, moreBeyondDepth: more, tests: items.filter((i) => i.role === 'test').length },
      };
    });
    changes.sort((a, b) => compareText(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.name, b.name));
    const affected = [...merged.values()].sort(byPlace);
    for (const a of affected) a.from.sort(compareText);

    const tests = testFiles(changes, affected);
    const modules = groupByModule(changes, affected);
    const structure = compareStructure(before, after, diffs, opts, root);

    const files: Record<Change, number> = { added: 0, removed: 0, modified: 0, moved: 0 };
    for (const d of diffs) {
      const indexed = (d.oldPath !== null && before.findFile(d.oldPath)) || (d.newPath !== null && after.findFile(d.newPath));
      if (indexed) files[fileChange(d)]++;
    }
    const names: Record<Change, number> = { added: 0, removed: 0, modified: 0, moved: 0 };
    for (const c of changes) if (c.kind !== 'file') names[c.change]++;

    return {
      base: { ref: opts.base, commit: baseCommit },
      head: { ref: opts.head ?? null, commit: headCommit },
      reindexed,
      config: config.path,
      summary: {
        files,
        names,
        depth: opts.depth,
        affected: affected.length,
        moreBeyondDepth,
        modules: modules.length,
        tests: tests.length,
        newCycles: structure.cycles.introduced.total,
        newViolations: structure.violations.introduced.total,
      },
      changes: cut(changes, opts.limit),
      affected: cut(affected, opts.limit),
      modules,
      tests: cut(tests, opts.limit),
      structure,
    };
  } finally {
    for (const s of opened) s.close();
  }
}

const placeKey = (path: string, kind: string, name: string) => `${path}\0${kind}\0${name}`;

function fileChange(d: FileDiff): Change {
  if (d.oldPath === null) return 'added';
  if (d.newPath === null) return 'removed';
  return d.oldPath === d.newPath ? 'modified' : 'moved';
}

/** 바뀐 것 하나와 그 영향 탐색의 출발점(바꾼 쪽 그래프의 노드). */
type Found = Omit<ChangedItem, 'module' | 'impact'> & { starts: NodeId[] };

/**
 * 파일마다 바뀐 줄을 이름으로 옮겨요. 바꾸기 전 줄은 바꾸기 전 색인의 이름에, 바꾼 뒤 줄은 바꾼 뒤 색인의 이름에.
 * 같은 경로의 이름은 열쇠로, 옮긴 파일의 이름은 바깥 타입을 붙인 이름과 종류로 짝지어요(열쇠에 경로가 들어 있어 달라져요).
 */
function changedNames(diffs: FileDiff[], before: GraphStore, after: GraphStore): Found[] {
  const out: Found[] = [];
  const symbolItem = (s: ExtentRow, change: Change, role: FileRole, movedFrom?: string): Found => ({
    name: s.qualifiedName,
    kind: s.kind,
    path: s.definition.path,
    line: s.definition.line,
    change,
    ...(movedFrom ? { movedFrom } : {}),
    role,
    confidence: s.confidence,
    source: s.source,
    starts: [nodeId({ symbol: s.key })],
  });
  for (const d of diffs) {
    const oldFile = d.oldPath === null ? null : before.findFile(d.oldPath);
    const newFile = d.newPath === null ? null : after.findFile(d.newPath);
    if (!oldFile && !newFile) continue; // 색인하지 않는 파일(문서, 설정 등)
    const fc = fileChange(d);
    const moved = fc === 'moved' ? d.oldPath! : undefined;
    // 파일 자체가 생기거나 지워지거나 옮겨졌으면 파일도 하나로. 영향은 그 파일을 가져다 쓰는 곳이에요.
    if (fc !== 'modified') {
      const path = (fc === 'removed' ? d.oldPath : d.newPath)!;
      out.push({
        name: path,
        kind: 'file',
        path,
        change: fc,
        ...(moved ? { movedFrom: moved } : {}),
        role: (newFile ?? oldFile)!.role,
        confidence: 'precise',
        source: 'git',
        starts: [nodeId({ file: path })],
      });
    }
    const was = oldFile ? before.extentsIn(oldFile.path) : [];
    const now = newFile ? after.extentsIn(newFile.path) : [];
    const touchedBefore = touched(was, d.oldLines);
    const touchedAfter = touched(now, d.newLines);
    const ident = (s: ExtentRow) => (moved ? `${s.kind}\0${s.qualifiedName}` : s.key);
    const waiting = new Map<string, ExtentRow[]>();
    for (const s of was) (waiting.get(ident(s)) ?? waiting.set(ident(s), []).get(ident(s))!).push(s);
    for (const s of now) {
      const old = waiting.get(ident(s))?.shift();
      if (!old) {
        out.push(symbolItem(s, 'added', newFile!.role));
      } else if (touchedBefore.has(old.key) || touchedAfter.has(s.key)) {
        out.push(symbolItem(s, 'modified', newFile!.role, moved));
      } else if (moved) {
        out.push(symbolItem(s, 'moved', newFile!.role, moved));
      }
    }
    for (const rest of waiting.values()) for (const s of rest) out.push(symbolItem(s, 'removed', oldFile!.role));
  }
  return out;
}

/** 바뀐 줄마다 그 줄을 품는 가장 안쪽 이름의 열쇠. */
function touched(extents: ExtentRow[], spans: LineSpan[]): Set<string> {
  const out = new Set<string>();
  for (const span of spans) {
    for (let line = span.start; line <= span.end; line++) {
      let best: ExtentRow | undefined;
      for (const e of extents) {
        if (e.extent.start > line || e.extent.end < line) continue;
        if (!best || e.extent.end - e.extent.start < best.extent.end - best.extent.start) best = e;
      }
      if (best) out.add(best.key);
    }
  }
  return out;
}

/** 고친 테스트 파일(거리 0)과 영향 범위에 걸린 테스트 파일. 표시는 모든 질의와 같은 규칙(sourcedOf). */
function testFiles(changes: ChangedItem[], affected: AffectedItem[]): ChangedTestFile[] {
  const files = new Map<string, { distance: number; parts: Sourced[] }>();
  const add = (path: string, distance: number, part: Sourced) => {
    const f = files.get(path) ?? files.set(path, { distance, parts: [] }).get(path)!;
    f.distance = Math.min(f.distance, distance);
    f.parts.push(part);
  };
  for (const c of changes) if (c.role === 'test' && c.change !== 'removed') add(c.path, 0, c);
  for (const a of affected) if (a.role === 'test') add(a.path, a.distance, a);
  return [...files]
    .map(([path, f]) => ({ path, distance: f.distance, ...sourcedOf(f.parts) }))
    .sort((a, b) => a.distance - b.distance || compareText(a.path, b.path));
}

function groupByModule(changes: ChangedItem[], affected: AffectedItem[]): ChangeModule[] {
  const groups = new Map<string | null, ChangeModule>();
  const get = (module: string | null) =>
    groups.get(module) ?? groups.set(module, { module, changed: 0, affected: 0, tests: 0 }).get(module)!;
  for (const c of changes) get(c.module).changed++;
  for (const a of affected) {
    const g = get(a.module);
    g.affected++;
    if (a.role === 'test') g.tests++;
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.changed - a.changed ||
      b.affected - a.affected ||
      (a.module === null ? 1 : 0) - (b.module === null ? 1 : 0) ||
      compareText(a.module ?? '', b.module ?? ''),
  );
}

/**
 * 양쪽에 같은 규칙(지금 저장소의 설정)으로 check를 돌려 비교해요. 옮긴 파일은 바꾸기 전 경로를 바꾼 뒤 경로로 맞춰 비교해요.
 * 순환: 같은 파일 묶음이 전에도 있었으면 existing, 겹치는 묶음이 있었으면 changed, 없었으면 new.
 * 경계 위반: 같은 (가져다 쓰는 파일, 대상)이 전에도 위반이었으면 existing, 아니면 새로 생긴 것.
 */
function compareStructure(
  before: GraphStore,
  after: GraphStore,
  diffs: FileDiff[],
  opts: DetectChangesOptions,
  root: string,
): DetectChangesBody['structure'] {
  const renamed = new Map<string, string>();
  for (const d of diffs) if (d.oldPath && d.newPath && d.oldPath !== d.newPath) renamed.set(d.oldPath, d.newPath);
  const toNew = (p: string) => renamed.get(p) ?? p;
  const toOld = new Map([...renamed].map(([o, n]) => [n, o]));
  const was: CheckBody = check(before, ALL, opts.config, root);
  const now: CheckBody = before === after ? was : check(after, ALL, opts.config, root);

  const oldCycles = was.cycles.items.map((c) => new Set(c.files.items.map(toNew)));
  const newCycles = now.cycles.items.map((c) => new Set(c.files.items));
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));
  const introducedCycles: IntroducedCycle[] = [];
  let existingCycles = 0;
  now.cycles.items.forEach((c, i) => {
    const files = newCycles[i]!;
    if (oldCycles.some((o) => same(o, files))) {
      existingCycles++;
      return;
    }
    const status = oldCycles.some((o) => overlaps(o, files)) ? 'changed' : 'new';
    introducedCycles.push({ ...c, files: cut(c.files.items, opts.limit), imports: cut(c.imports.items, opts.limit), status });
  });
  const resolvedCycles = oldCycles.filter((o) => !newCycles.some((n) => overlaps(o, n))).length;

  const pair = (from: string, to: string) => `${from}\0${to}`;
  const violations = (c: CheckBody) => c.backwardImports.items.filter((b) => !b.allowed);
  const oldViolations = new Set(violations(was).map((b) => pair(toNew(b.from), toNew(b.to))));
  const newViolations = violations(now);
  const nowKeys = new Set(newViolations.map((b) => pair(b.from, b.to)));
  const introduced: IntroducedViolation[] = newViolations
    .filter((b) => !oldViolations.has(pair(b.from, b.to)))
    .map((b) => {
      const oldFrom = toOld.get(b.from) ?? b.from;
      const existed = before.importsOf(oldFrom).some((t) => toNew(t.path) === b.to);
      return { ...b, newImport: !existed };
    });

  return {
    cycles: { introduced: cut(introducedCycles, opts.limit), existing: existingCycles, resolved: resolvedCycles },
    violations: {
      introduced: cut(introduced, opts.limit),
      existing: newViolations.length - introduced.length,
      resolved: [...oldViolations].filter((k) => !nowKeys.has(k)).length,
    },
  };
}

export const detectChangesQuery: QueryDef = {
  name: 'detect_changes',
  description:
    '작업 중인 diff(커밋하지 않은 것과 새 파일 포함), 또는 두 커밋·브랜치 사이의 변경이 건드린 이름과 그 영향 범위를 보여줘요. ' +
    '이름마다 바뀜(added/removed/modified/moved)과 영향 요약이 붙고, 모두 합친 영향 받는 곳(어느 바뀐 이름에서 닿았는지, 그곳도 고쳤는지), ' +
    '닿는 모듈, 돌려 볼 테스트 파일, 이 변경으로 새로 생긴 순환과 경계 위반(이미 있던 것과 구분)이 나와요. ' +
    '커밋이나 push 전에 놓친 곳을 확인할 때, PR의 리뷰 범위를 잡을 때 불러요. 작업 트리를 볼 때 색인이 낡았으면 다시 색인해요. ' +
    'base 커밋은 처음 한 번 따로 색인해서(저장소 색인과 같은 시간이 걸려요) 그 뒤로는 바로 답해요.',
  params: [
    {
      name: 'base',
      type: 'string',
      default: 'HEAD',
      description: '비교 기준 커밋이나 브랜치. PR이면 갈라진 지점(git merge-base main HEAD의 결과)을 줘요.',
    },
    {
      name: 'head',
      type: 'string',
      description: '바꾼 쪽 커밋이나 브랜치. 없으면 작업 트리(커밋하지 않은 것과 추적하지 않는 새 파일 포함)예요.',
    },
    { name: 'depth', type: 'integer', min: 1, default: DEFAULT_DEPTH, description: '바뀐 이름마다 몇 단계까지 영향을 거슬러 올라갈지. 직접 쓰는 곳이 1.' },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '목록(바뀐 이름, 영향 받는 곳, 테스트 파일, 새 순환·위반)마다 앞에서부터 몇 개까지 줄지.' },
    {
      name: 'hot',
      type: 'integer',
      min: 1,
      default: DEFAULT_HOT_USES,
      description: `영향 받는 곳 가운데 사용처가 이 수 이상인 이름에 hot 표시를 붙여요(기본 ${DEFAULT_HOT_USES}).`,
    },
    CONFIG_PARAM,
  ],
  run: (store, args, ctx) =>
    detectChanges(store, {
      base: args.base as string,
      head: args.head as string | undefined,
      depth: args.depth as number,
      limit: args.limit as number,
      hotUses: args.hot as number,
      config: args.config as string | undefined,
      db: ctx.db,
    }),
};
