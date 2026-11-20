// impact: 이름이나 파일을 바꾸면 영향 받는 곳. 직접 쓰는 곳에서 시작해 그곳을 쓰는 곳으로 거슬러 올라가요(graph.reach 'in').
// 영향 받는 곳은 거리별로 세고 모듈별로 묶고, 걸린 테스트 파일은 따로 모아요. 많이 쓰이는 이름에는 hot 표시가 붙어요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { compareText, cut, DEFAULT_LIMIT, type Page, type Sourced, sourcedOf } from '../answer.ts';
import type { FileRole, RelationKind, SymbolKind } from '../facts.ts';
import type { GraphStore, Location, SymbolRow } from '../graph/store.ts';
import { Graph, nodeId, type NodeId, type Reached } from '../graph/traverse.ts';
import { type ModuleOf, repoModules } from '../modules.ts';
import type { QueryDef } from '../queries.ts';
import { CONFIG_PARAM } from '../repo-config.ts';
import { locationOf, pointOfNode, resolvePoint } from './point.ts';

/** "많이 쓰이는 이름"의 기본 기준: 사용처(어느 종류의 관계든)가 이만큼 이상이면 hot이에요. */
export const DEFAULT_HOT_USES = 20;
export const DEFAULT_DEPTH = 3;

/** 영향 받는 곳 하나. 심볼(사용처를 감싸는 이름)이거나, 파일 최상위에서 쓰면(import 등) 그 파일이에요. */
export interface ImpactItem extends Sourced {
  /** 심볼이면 바깥 타입을 붙인 이름, 파일이면 경로. */
  name: string;
  kind: SymbolKind;
  path: string;
  /** 정의가 있는 줄(1부터). 파일이면 없어요. */
  line?: number;
  /** 바꾼 것에서 몇 단계 떨어졌는지. 직접 쓰면 1. */
  distance: number;
  /** 저장소 설정으로 정한 모듈. 어느 규칙에도 맞지 않으면 null. */
  module: string | null;
  role: FileRole;
  /** 심볼의 사용처 수와 많이 쓰이는 이름인지. 파일이면 없어요. */
  uses?: number;
  hot?: boolean;
  /** 이곳이 바꾼 쪽으로 한 단계 다가가며 쓰는 것과 그 관계. */
  via: { name: string; relation: RelationKind; at: Location };
}

/** 영향 범위에 걸린 테스트 파일. */
export interface ImpactTestFile extends Sourced {
  path: string;
  /** 그 파일 안의 영향 받는 곳 가운데 가장 가까운 거리. */
  distance: number;
}

/** 모듈 하나에 든 영향 받는 곳의 수. */
export interface ImpactModule {
  module: string | null;
  affected: number;
  /** 가장 가까운 거리. */
  nearest: number;
  /** 그 가운데 테스트 파일에 있는 것. */
  tests: number;
}

export type ImpactTarget =
  | (Omit<SymbolRow, 'key'> & { uses: number; hot: boolean })
  | { path: string; language: string; role: FileRole; names: number; hotNames: string[] };

/** impact 답의 몸통. */
export interface ImpactBody {
  [key: string]: unknown;
  query: string;
  status: 'found' | 'ambiguous' | 'not_found';
  /** 읽은 저장소 설정 파일. 기본 설정이면 null. */
  config?: string | null;
  /** status가 ambiguous일 때. 각 후보의 qualifiedName이나 key로 다시 물어요. */
  candidates?: SymbolRow[];
  target?: ImpactTarget;
  summary?: {
    depth: number;
    affected: number;
    /** 거리 → 영향 받는 곳의 수. */
    byDistance: Record<string, number>;
    /** depth 바로 다음 단계에도 영향 받는 곳이 있는지. true면 depth를 늘려 다시 물어요. */
    moreBeyondDepth: boolean;
    modules: number;
    tests: number;
    /** 이번 답의 hot 기준(사용처 수). */
    hotUses: number;
  };
  /** 모듈별 묶음. 가까운 모듈부터(같으면 많은 것, 이름 순, 모듈 밖(null)은 뒤). 모듈 수만큼이라 자르지 않아요. */
  modules?: ImpactModule[];
  /** 영향 받는 곳. 거리, 경로, 줄, 이름 순. */
  affected?: Page<ImpactItem>;
  /** 영향 범위에 걸린 테스트 파일. 거리, 경로 순. */
  tests?: Page<ImpactTestFile>;
}

export interface ImpactOptions {
  depth: number;
  limit: number;
  hotUses: number;
  config?: string;
}

export function impact(store: GraphStore, query: string, opts: ImpactOptions): ImpactBody {
  const graph = Graph.load(store);
  const counts = store.useCounts();
  const isHot = (key: string) => (counts.get(key) ?? 0) >= opts.hotUses;

  // 출발점: 파일이면 그 파일과 그 파일이 정의한 이름, 이름이면 그 심볼과 그 안의 것(멤버, 생성자).
  let starts: NodeId[];
  let target: ImpactTarget;
  const point = resolvePoint(store, query);
  if (point.status === 'not_found') return { query, status: 'not_found' };
  if (point.status === 'ambiguous') return { query, status: 'ambiguous', candidates: point.candidates };
  if (point.status === 'file') {
    starts = graph.fileNodes(point.file.path);
    const names = starts.map((id) => graph.node(id)?.symbol).filter((s) => s !== undefined);
    target = {
      ...point.file,
      names: names.length,
      hotNames: names.filter((s) => isHot(s.key)).map((s) => s.qualifiedName).sort(compareText),
    };
  } else {
    const { key, ...symbol } = point.symbol;
    starts = graph.members(nodeId({ symbol: key }));
    target = { ...symbol, uses: counts.get(key) ?? 0, hot: isHot(key) };
  }

  const { config, moduleOf } = repoModules(store, opts.config);
  const { items, moreBeyondDepth } = reachImpact({ graph, moduleOf, counts, hotUses: opts.hotUses, depth: opts.depth }, starts);

  const byDistance: Record<string, number> = {};
  for (const item of items) byDistance[item.distance] = (byDistance[item.distance] ?? 0) + 1;
  const modules = groupByModule(items);
  const tests = testFiles(items);

  return {
    query,
    status: 'found',
    config: config.path,
    target,
    summary: {
      depth: opts.depth,
      affected: items.length,
      byDistance,
      moreBeyondDepth,
      modules: modules.length,
      tests: tests.length,
      hotUses: opts.hotUses,
    },
    modules,
    affected: cut(items, opts.limit),
    tests: cut(tests, opts.limit),
  };
}

/** 영향 범위를 찾는 데 필요한 것. 한 번 만들어 여러 출발점에 써요(detect_changes는 바뀐 이름마다). */
export interface ImpactScope {
  graph: Graph;
  moduleOf: ModuleOf;
  /** 심볼별 사용처 수(GraphStore.useCounts). */
  counts: Map<string, number>;
  hotUses: number;
  depth: number;
}

/**
 * 출발점에서 쓰는 쪽으로 depth까지 거슬러 올라간 영향 받는 곳(거리, 경로, 줄, 이름 순)과,
 * depth 바로 다음 단계에도 닿는 곳이 있는지.
 */
export function reachImpact(scope: ImpactScope, starts: NodeId[]): { items: ImpactItem[]; moreBeyondDepth: boolean } {
  const { graph, depth } = scope;
  // depth 다음 단계까지 한 번 더 가 보고, 그 단계는 "더 있음" 표시에만 써요.
  const reached = graph.reach(starts, 'in', depth + 1).filter((r) => r.distance > 0);
  const items = reached
    .filter((r) => r.distance <= depth)
    .map((r) => toItem(graph, r, scope.moduleOf, scope.counts, scope.hotUses))
    .sort(byPlace);
  return { items, moreBeyondDepth: reached.some((r) => r.distance > depth) };
}

function toItem(graph: Graph, r: Reached, moduleOf: ModuleOf, counts: Map<string, number>, hotUses: number): ImpactItem {
  const info = graph.node(r.node)!;
  const point = pointOfNode(info);
  const via = r.via!;
  const viaNode = graph.node(via.from);
  const uses = point.key !== undefined ? (counts.get(point.key) ?? 0) : undefined;
  return {
    name: point.name,
    kind: point.kind,
    path: point.path,
    ...(point.line !== undefined ? { line: point.line } : {}),
    distance: r.distance,
    module: moduleOf(info.path),
    role: info.role,
    ...(uses !== undefined ? { uses, hot: uses >= hotUses } : {}),
    via: { name: viaNode ? pointOfNode(viaNode).name : via.from, relation: via.edge.kind, at: locationOf(via.edge.at) },
    confidence: r.confidence,
    source: via.edge.source,
  };
}

export function byPlace(a: ImpactItem, b: ImpactItem): number {
  return (
    a.distance - b.distance ||
    compareText(a.path, b.path) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.name, b.name)
  );
}

function groupByModule(items: ImpactItem[]): ImpactModule[] {
  const groups = new Map<string | null, ImpactModule>();
  for (const item of items) {
    const g = groups.get(item.module) ?? { module: item.module, affected: 0, nearest: item.distance, tests: 0 };
    g.affected++;
    g.nearest = Math.min(g.nearest, item.distance);
    if (item.role === 'test') g.tests++;
    groups.set(item.module, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.nearest - b.nearest ||
      b.affected - a.affected ||
      (a.module === null ? 1 : 0) - (b.module === null ? 1 : 0) ||
      compareText(a.module ?? '', b.module ?? ''),
  );
}

/**
 * 테스트 파일마다 가장 가까운 거리. 표시는 모든 질의와 같은 규칙(sourcedOf): 그 파일의 영향 받는 곳 가운데
 * 가장 낮은 믿음(하나라도 추정이면 추정)과 출처 모두.
 */
export function testFiles(items: ImpactItem[]): ImpactTestFile[] {
  const files = new Map<string, ImpactItem[]>();
  for (const item of items) {
    if (item.role !== 'test') continue;
    const list = files.get(item.path);
    if (list) list.push(item);
    else files.set(item.path, [item]);
  }
  return [...files.entries()]
    .map(([path, list]) => ({ path, distance: Math.min(...list.map((i) => i.distance)), ...sourcedOf(list) }))
    .sort((a, b) => a.distance - b.distance || compareText(a.path, b.path));
}

export const impactQuery: QueryDef = {
  name: 'impact',
  description:
    '이름(심볼)이나 파일을 바꾸면 영향 받는 곳을 미리 보여줘요. 직접 쓰는 곳(거리 1)에서 시작해 그곳을 쓰는 곳(거리 2, 3, …)으로 거슬러 올라가요. ' +
    '영향 받는 곳마다 거리, 모듈, 앱/테스트, 한 단계 가까이 가며 쓰는 것(via)이 붙고, 모듈별 묶음과 걸린 테스트 파일 목록이 따로 나와요. ' +
    '사용처가 많은 이름에는 hot이 붙어요. 추정 관계를 거쳐 닿은 곳은 confidence가 inferred예요. ' +
    '이름을 바꾸거나 시그니처를 고치기 전에, 또는 어느 테스트를 돌릴지 고를 때 불러요. 같은 이름이 여럿이면 후보(candidates)를 돌려주니 qualifiedName이나 key로 다시 물어요.',
  params: [
    {
      name: 'target',
      type: 'string',
      positional: true,
      required: true,
      description: '바꿀 이름이나 파일. 짧은 이름(withTax), 바깥 타입을 붙인 이름(Cart.add), 심볼 열쇠(key), 저장소 기준 파일 경로(lib/src/cart.dart) 중 하나.',
    },
    { name: 'depth', type: 'integer', min: 1, default: DEFAULT_DEPTH, description: '몇 단계까지 거슬러 올라갈지. 직접 쓰는 곳이 1.' },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '목록(영향 받는 곳, 테스트 파일)마다 앞에서부터 몇 개까지 줄지.' },
    {
      name: 'hot',
      type: 'integer',
      min: 1,
      default: DEFAULT_HOT_USES,
      description: `사용처가 이 수 이상인 이름에 hot 표시를 붙여요(기본 ${DEFAULT_HOT_USES}).`,
    },
    CONFIG_PARAM,
  ],
  run: (store, args) =>
    impact(store, args.target as string, {
      depth: args.depth as number,
      limit: args.limit as number,
      hotUses: args.hot as number,
      config: args.config as string | undefined,
    }),
};
