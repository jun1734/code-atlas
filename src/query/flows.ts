// flows: 진입점에서 시작하는 실행 흐름. 낯선 기능의 큰 줄기를 빨리 파악하는 데 써요.
// 이름 하나를 주면 그 이름이 든 묶음(clusters)과 그 이름을 거치는 흐름만 돌려줘요.
//
// 알고리즘(docs/architecture.md "질의: flows"):
// 1. 코드를 돌리는 관계만 따라가요: 호출(call)과, 읽으면 코드가 도는 것의 읽기(read: getter, 모듈 수준 변수의 초기화 식).
//    앱 코드의 심볼만 보고, 테스트 코드의 호출은 셈하지 않아요.
// 2. 진입점: 앱 코드 어디서도 불리지 않으면서 무언가를 부르는 이름(uncalled), 밖에서 불리지 않는 순환의
//    첫 이름(cycle), 저장소 설정 flows.entries에 맞는 이름(config).
// 3. 흐름 하나: 진입점에서 호출을 깊이 우선으로 따라가요. 한 이름이 부르는 것들은 호출이 적힌 자리 순이라
//    "거치는 이름이 순서대로"가 대략 실행 순서예요. 흐름 안에서 이미 나온 이름은 다시 펼치지 않아요.
//
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { compareText, cut, DEFAULT_LIMIT, lowest, type Page, type Sourced, sourcedOf } from '../answer.ts';
import type { Confidence, SymbolKind } from '../facts.ts';
import type { EdgeRow, GraphStore, Location, SymbolRow } from '../graph/store.ts';
import { Graph, type NodeId, nodeId } from '../graph/traverse.ts';
import { nameGlobToRegExp } from '../modules.ts';
import type { QueryDef } from '../queries.ts';
import { CONFIG_PARAM, loadRepoConfig } from '../repo-config.ts';
import { stronglyConnected } from './check.ts';
import { type ClusterItem, clustersOf } from './clusters.ts';
import { locationOf, type Point, pointOfFile, pointOfNode, pointOfSymbol, resolvePoint } from './point.ts';

export const DEFAULT_FLOW_DEPTH = 10;
export const DEFAULT_FLOW_LENGTH = 30;

/** 진입점이 된 까닭. uncalled: 불리지 않음, cycle: 밖에서 불리지 않는 순환의 첫 이름, config: 설정으로 지정. */
export type EntryReason = 'uncalled' | 'cycle' | 'config';

/** 흐름의 구간 하나: from이 부르는(또는 읽어 코드를 돌리는) 이름(name)에 처음 닿은 곳. */
export interface FlowStep extends Sourced {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  column: number;
  key: string;
  /** 진입점에서 몇 번 불러 닿았는지(진입점이 부르면 1). */
  depth: number;
  /** 이 이름을 부른 이름. */
  from: string;
  /** 관계 종류. call: 부름, read: getter나 모듈 수준 변수를 읽음(읽으면 코드가 돌아요). */
  relation: FlowRelation;
  /** 관계가 적힌 자리. */
  at: Location;
  /** 관계 종류(relation)의 믿음(Dart의 call·read는 문법으로 가려 inferred). */
  kindConfidence: Confidence;
}

/** 흐름 하나. confidence·kindConfidence는 구간 가운데 가장 낮은 것이에요(구간이 없으면 진입점의 표시). */
export interface FlowItem extends Sourced {
  /** 진입점. */
  entry: Point;
  reasons: EntryReason[];
  /** 흐름이 거치는 이름 수(진입점 포함, depth 안). */
  size: number;
  kindConfidence: Confidence;
  /** depth 밖에도 더 부르는 이름이 있으면 true. depth를 늘려 다시 물어요. */
  beyondDepth: boolean;
  /** 진입점 다음부터 거치는 이름, 순서대로. length개까지. */
  steps: Page<FlowStep>;
  /** 이름을 물었을 때: 이 흐름에서 물은 이름(과 그 멤버)에 맞은 이름, 흐름 순. */
  hits?: string[];
}

export interface FlowsBody {
  [key: string]: unknown;
  query: string | null;
  config: string | null;
  depth: number;
  length: number;
  /** 이름을 물었을 때만. */
  status?: 'found' | 'ambiguous' | 'not_found';
  target?: Point;
  candidates?: SymbolRow[];
  summary?: {
    /** 진입점 수(= 흐름 수, 이름을 물었으면 거르기 전). */
    entries: number;
    uncalled: number;
    cycles: number;
    configured: number;
    /** 설정의 진입점 가운데 맞는 이름이 없는 것(name glob). */
    unmatched: string[];
  };
  /** 이름을 물었을 때: 그 이름이 든 묶음(clusters와 같은 꼴). */
  clusters?: Page<ClusterItem>;
  /** 흐름, 큰 것부터(같으면 진입점 이름, 열쇠 순). 이름을 물었으면 그 이름을 거치는 흐름만. */
  flows?: Page<FlowItem>;
}

export interface FlowsOptions {
  /** 이 이름(또는 파일)을 거치는 흐름만. */
  name?: string;
  depth: number;
  length: number;
  limit: number;
  config?: string;
}

const RANK: Record<Confidence, number> = { precise: 0, inferred: 1 };

/** 같은 두 이름 사이 호출이 여럿이면 대표 하나: 정밀한 것, 종류가 정밀한 것, 적힌 자리 순. */
function better(a: EdgeRow, b: EdgeRow): boolean {
  return (
    (RANK[a.confidence] - RANK[b.confidence] ||
      RANK[a.kindConfidence] - RANK[b.kindConfidence] ||
      compareSite(a, b)) < 0
  );
}

function compareSite(a: EdgeRow, b: EdgeRow): number {
  return compareText(a.at.path, b.at.path) || a.at.line - b.at.line || a.at.column - b.at.column;
}

/** 흐름이 따라가는 관계 종류. */
export type FlowRelation = 'call' | 'read';

/** 흐름을 계산하는 그래프: 앱 코드 심볼 사이의, 코드를 돌리는 관계만. */
class CallGraph {
  private readonly next = new Map<NodeId, [NodeId, EdgeRow][]>();
  readonly graph: Graph;

  constructor(store: GraphStore) {
    this.graph = Graph.load(store, { kinds: ['call', 'read'] });
  }

  /**
   * 코드를 돌리는 관계인지. 부름은 모두, 읽기는 읽으면 코드가 도는 것만: getter(본문)와 모듈 수준 변수(초기화 식.
   * Dart의 최상위 변수는 처음 읽을 때 초기화되고, Riverpod provider도 이렇게 읽혀요). 필드·상수의 읽기는 빼요.
   */
  private runs(e: EdgeRow): boolean {
    if (e.kind === 'call') return true;
    const target = this.graph.node(nodeId(e.to))?.symbol;
    return !!target && (target.kind === 'getter' || (target.kind === 'variable' && target.parentKey === null));
  }

  /** 앱 코드의 심볼인지(이름 공간 빼고). */
  isName(id: NodeId): boolean {
    const n = this.graph.node(id);
    return !!n?.symbol && n.role === 'app' && n.symbol.kind !== 'namespace';
  }

  /** 이 이름이 부르는 이름과 대표 호출. 호출이 적힌 자리 순(같으면 id 순)이에요. */
  callees(u: NodeId): [NodeId, EdgeRow][] {
    let list = this.next.get(u);
    if (!list) {
      const best = new Map<NodeId, EdgeRow>();
      for (const e of this.graph.out(u)) {
        const v = nodeId(e.to);
        if (!this.isName(v) || !this.runs(e)) continue;
        const prev = best.get(v);
        if (!prev || better(e, prev)) best.set(v, e);
      }
      list = [...best.entries()].sort(([a, ea], [b, eb]) => compareSite(ea, eb) || compareText(a, b));
      this.next.set(u, list);
    }
    return list;
  }

  /** 앱 코드(파일 최상위 포함)에서 이 이름을 부르는(읽어 돌리는) 이름. 파일 노드일 수 있어요. */
  callers(v: NodeId): NodeId[] {
    return this.graph
      .in(v)
      .filter((e) => e.at.role === 'app' && this.runs(e))
      .map((e) => nodeId(e.from));
  }
}

interface Entry {
  id: NodeId;
  reasons: EntryReason[];
}

/** 진입점 찾기. 순서는 상관없어요(흐름을 다 만든 뒤 정렬해요). */
function findEntries(cg: CallGraph, store: GraphStore, configPath: string | undefined) {
  const config = loadRepoConfig(store.meta().repoRoot, configPath);
  const entries = new Map<NodeId, EntryReason[]>();
  const add = (id: NodeId, reason: EntryReason) => (entries.get(id) ?? entries.set(id, []).get(id)!).push(reason);
  const names = cg.graph.allNodes().filter((n) => cg.isName(n.id));
  let uncalled = 0;
  let cycles = 0;

  if (config.flows.uncalled) {
    // 불리지 않는 이름: 앱 코드에서 부르는 곳이 없고, 앱 코드의 이름을 하나라도 부르는 것.
    for (const n of names) {
      if (cg.callees(n.id).length > 0 && cg.callers(n.id).length === 0) {
        add(n.id, 'uncalled');
        uncalled++;
      }
    }
    // 서로만 부르는 순환: 강연결 요소(둘 이상) 가운데 밖에서 부르는 곳이 없는 것. id가 가장 작은 이름이 진입점이에요.
    const ids = names.map((n) => n.id).sort(compareText);
    for (const group of stronglyConnected(ids, (v) => cg.callees(v).map(([w]) => w))) {
      if (group.length < 2) continue;
      const inside = new Set(group);
      if (group.some((v) => cg.callers(v).some((c) => !inside.has(c)))) continue;
      add([...group].sort(compareText)[0]!, 'cycle');
      cycles++;
    }
  }

  // 설정으로 지정한 이름: 바깥 타입을 붙인 이름에 glob을 맞춰요.
  const unmatched: string[] = [];
  let configured = 0;
  for (const m of config.flows.entries) {
    const re = nameGlobToRegExp(m.name);
    const hit = names.filter((n) => (!m.kinds || m.kinds.includes(n.symbol!.kind)) && re.test(n.symbol!.qualifiedName));
    if (hit.length === 0) unmatched.push(m.name);
    for (const n of hit) {
      if (entries.get(n.id)?.includes('config')) continue;
      add(n.id, 'config');
      configured++;
    }
  }

  const list: Entry[] = [...entries].map(([id, reasons]) => ({ id, reasons }));
  return { config, list, summary: { entries: list.length, uncalled, cycles, configured, unmatched } };
}

interface Walked {
  /** 진입점 다음부터 거치는 이름, 순서대로. */
  steps: { id: NodeId; from: NodeId; edge: EdgeRow; depth: number }[];
  beyondDepth: boolean;
}

/**
 * 진입점에서 호출을 깊이 우선(앞 순회)으로 따라가요. 부르는 것들은 호출이 적힌 자리 순이에요.
 * 흐름 안에서 이미 나온 이름은 다시 펼치지 않아요(순환도 여기서 끊겨요).
 */
function walk(cg: CallGraph, entry: NodeId, maxDepth: number): Walked {
  const depthOf = new Map<NodeId, number>([[entry, 0]]);
  const steps: Walked['steps'] = [];
  const visit = (u: NodeId, d: number) => {
    if (d >= maxDepth) return;
    for (const [v, edge] of cg.callees(u)) {
      if (depthOf.has(v)) continue;
      depthOf.set(v, d + 1);
      steps.push({ id: v, from: u, edge, depth: d + 1 });
      visit(v, d + 1);
    }
  };
  visit(entry, 0);
  // depth 끝에 닿은 이름이 흐름에 없는 이름을 더 부르면, depth 밖에도 흐름이 이어져요.
  const beyondDepth = [...depthOf].some(([u, d]) => d === maxDepth && cg.callees(u).some(([v]) => !depthOf.has(v)));
  return { steps, beyondDepth };
}

function describe(cg: CallGraph, id: NodeId): Point {
  const n = cg.graph.node(id);
  if (!n) throw new Error(`그래프에 없는 노드: ${id}`);
  return pointOfNode(n);
}

function toFlow(cg: CallGraph, entry: Entry, walked: Walked, length: number): FlowItem {
  const entryPoint = describe(cg, entry.id);
  const steps: FlowStep[] = walked.steps.map((s) => {
    const p = describe(cg, s.id);
    return {
      name: p.name,
      kind: p.kind,
      path: p.path,
      line: p.line!,
      column: p.column!,
      key: p.key!,
      depth: s.depth,
      from: describe(cg, s.from).name,
      relation: s.edge.kind as FlowRelation,
      at: locationOf(s.edge.at),
      confidence: s.edge.confidence,
      kindConfidence: s.edge.kindConfidence,
      source: s.edge.source,
    };
  });
  const marks: (Sourced & { kindConfidence: Confidence })[] =
    steps.length > 0 ? steps : [{ confidence: entryPoint.confidence!, kindConfidence: entryPoint.confidence!, source: entryPoint.source! }];
  return {
    entry: entryPoint,
    reasons: entry.reasons,
    size: steps.length + 1,
    ...sourcedOf(marks),
    kindConfidence: lowest(marks.map((m) => m.kindConfidence)),
    beyondDepth: walked.beyondDepth,
    steps: cut(steps, length),
  };
}

export function flows(store: GraphStore, opts: FlowsOptions): FlowsBody {
  const cg = new CallGraph(store);
  const { config, list, summary } = findEntries(cg, store, opts.config);
  const head = { query: opts.name ?? null, config: config.path, depth: opts.depth, length: opts.length };

  // 이름을 물었으면 먼저 풀어요(여럿이면 고르지 않아요).
  let target: Point | undefined;
  let wanted: Set<NodeId> | undefined;
  if (opts.name !== undefined) {
    const point = resolvePoint(store, opts.name);
    if (point.status === 'not_found') return { ...head, status: 'not_found' };
    if (point.status === 'ambiguous') return { ...head, status: 'ambiguous', candidates: point.candidates };
    if (point.status === 'file') {
      target = pointOfFile(point.file.path);
      wanted = new Set(cg.graph.fileNodes(point.file.path));
    } else {
      target = pointOfSymbol(point.symbol);
      wanted = new Set(cg.graph.members(`s:${point.symbol.key}`));
    }
  }

  let all = list.map((entry) => {
    const walked = walk(cg, entry.id, opts.depth);
    const flow = toFlow(cg, entry, walked, opts.length);
    if (wanted) {
      const passed = [entry.id, ...walked.steps.map((s) => s.id)].filter((id) => wanted.has(id));
      flow.hits = passed.map((id) => describe(cg, id).name);
    }
    return flow;
  });
  if (wanted) all = all.filter((f) => f.hits!.length > 0);
  all.sort((a, b) => b.size - a.size || compareText(a.entry.name, b.entry.name) || compareText(a.entry.key ?? '', b.entry.key ?? ''));

  const page = cut(all, opts.limit);
  if (!wanted) return { ...head, summary, flows: page };
  const clusters = clustersOf(store, [...wanted], opts.limit, opts.config);
  return { ...head, status: 'found', target, summary, clusters, flows: page };
}

export const flowsQuery: QueryDef = {
  name: 'flows',
  description:
    '진입점에서 시작하는 실행 흐름(호출을 따라 거치는 이름들, 호출이 적힌 순서대로)을 보여 줘요. 낯선 기능의 큰 줄기를 빨리 파악할 때 불러요. ' +
    '진입점은 앱 코드 어디서도 불리지 않는 이름, 밖에서 불리지 않는 순환의 첫 이름, 저장소 설정(.code-atlas.json의 flows.entries)으로 지정한 이름이에요. 테스트 코드의 호출은 셈하지 않아요. ' +
    '이름(name)을 주면 그 이름이 든 묶음(clusters와 같은 꼴)과 그 이름을 거치는 흐름만 돌려줘요: 변경이 어떤 사용자 경로에 닿는지 볼 때 써요. ' +
    '구간마다 믿음(confidence: 호출이 있는지, kindConfidence: 호출이 맞는지)이 붙고, 흐름의 믿음은 구간 가운데 가장 낮은 것이에요. 같은 이름이 여럿이면 후보(candidates)를 돌려줘요.',
  params: [
    {
      name: 'name',
      type: 'string',
      positional: true,
      description: '이 이름(짧은 이름, 바깥 타입을 붙인 이름, key, 또는 파일 경로)을 거치는 흐름과 그 이름이 든 묶음만. 없으면 흐름 전부.',
    },
    CONFIG_PARAM,
    { name: 'depth', type: 'integer', min: 1, default: DEFAULT_FLOW_DEPTH, description: '진입점에서 몇 번 부른 데까지 따라갈지.' },
    { name: 'length', type: 'integer', min: 1, default: DEFAULT_FLOW_LENGTH, description: '흐름마다 보여 줄 이름 수(진입점 다음부터).' },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '흐름(과 묶음)을 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) =>
    flows(store, {
      name: args.name as string | undefined,
      config: args.config as string | undefined,
      depth: args.depth as number,
      length: args.length as number,
      limit: args.limit as number,
    }),
};
