// trace: 두 지점(이름 또는 파일) 사이의 호출·의존 경로. "이 버튼이 어떻게 저 함수까지 가나"에 답해요.
// 가장 짧은 경로가 먼저, 다른 경로가 짧은 순으로 뒤에 와요. 길이 없으면 없다고 답해요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { DEFAULT_LIMIT, page, type Page, type Sourced } from '../answer.ts';
import type { Confidence, RelationKind } from '../facts.ts';
import type { GraphStore, Location, SymbolRow } from '../graph/store.ts';
import { Graph, type GraphPath, type NodeId } from '../graph/traverse.ts';
import { UserError } from '../locate.ts';
import type { QueryDef } from '../queries.ts';

/** 따라갈 관계. calls: 호출만, all: 참조·읽기·쓰기·상속·구현·import까지 모두. */
export type Follow = 'calls' | 'all';
const FOLLOW_KINDS: Record<Follow, RelationKind[] | undefined> = { calls: ['call'], all: undefined };

/** 경로 수를 세다 멈추는 상한. 큰 저장소에서 경로 수가 폭발하는 것을 막아요. */
export const PATH_CAP = 1000;

/**
 * 경로에 나오는 지점 하나. 심볼이면 key로 context에 다시 물을 수 있고, 정의를 낸 색인기의 표시(confidence, source)가 붙어요.
 * 파일이면 name이 경로이고 표시가 없어요(파일 지점은 계약의 예외: 색인기의 추정이 아니라 저장소의 파일이에요).
 */
export interface TraceNode {
  name: string;
  kind: string;
  path: string;
  line?: number;
  column?: number;
  key?: string;
  confidence?: Confidence;
  source?: string;
}

/** 경로의 구간 하나: from이 to를 쓰는 관계 하나. */
export interface TraceStep extends Sourced {
  from: string;
  to: string;
  kind: RelationKind;
  /** 관계가 적힌 자리. */
  at: Location;
  /** 종류(kind)를 믿는 정도. Dart의 call·read·write·reference는 문법으로 가려 inferred예요. */
  kindConfidence: Confidence;
}

/** 경로 하나. steps[i]가 nodes[i]에서 nodes[i + 1]로 가요. confidence·kindConfidence는 구간 가운데 가장 낮은 것이에요. */
export interface TracePath extends Sourced {
  length: number;
  kindConfidence: Confidence;
  nodes: TraceNode[];
  steps: TraceStep[];
}

export interface TraceBody {
  [key: string]: unknown;
  query: { from: string; to: string };
  follow: Follow;
  depth: number;
  status: 'found' | 'no_path' | 'ambiguous' | 'not_found';
  from?: TraceNode;
  to?: TraceNode;
  paths?: Page<TracePath> & { capped: boolean };
  /** no_path일 때: to에서 from으로는 이어지는지(물은 방향이 거꾸로였는지). */
  reverse?: boolean;
  /** no_path일 때: depth보다 긴 경로가 있으면 그 가장 짧은 길이. depth를 늘려 다시 물어요. */
  shortestBeyondDepth?: number;
  /** ambiguous일 때: 이름이 여럿에 맞은 쪽의 후보. qualifiedName이나 key로 다시 물어요. */
  candidates?: { from?: SymbolRow[]; to?: SymbolRow[] };
  /** not_found일 때: 찾지 못한 쪽. */
  notFound?: ('from' | 'to')[];
}

type Resolved =
  | { status: 'found'; node: TraceNode; ids: NodeId[] }
  | { status: 'ambiguous'; candidates: SymbolRow[] }
  | { status: 'not_found' };

/** 물은 글을 지점으로: 색인된 파일 경로면 그 파일과 그 파일이 정의한 심볼, 이름이면 그 심볼과 그 멤버. */
function resolve(store: GraphStore, graph: Graph, query: string): Resolved {
  const file = store.findFile(query.replaceAll('\\', '/'));
  if (file) return { status: 'found', node: { name: file.path, kind: 'file', path: file.path }, ids: graph.fileNodes(file.path) };
  const found = store.findSymbols(query);
  if (found.length === 0) return { status: 'not_found' };
  if (found.length > 1) return { status: 'ambiguous', candidates: found };
  const s = found[0]!;
  return { status: 'found', node: symbolNode(s), ids: graph.members(`s:${s.key}`) };
}

function symbolNode(s: SymbolRow): TraceNode {
  const d = s.definition;
  return { name: s.qualifiedName, kind: s.kind, path: d.path, line: d.line, column: d.column, key: s.key, confidence: s.confidence, source: s.source };
}

function describe(graph: Graph, id: NodeId): TraceNode {
  const n = graph.node(id);
  if (!n) throw new Error(`그래프에 없는 노드: ${id}`);
  if (!n.symbol) return { name: n.path, kind: 'file', path: n.path };
  return symbolNode(n.symbol);
}

const lowest = (cs: Confidence[]): Confidence => (cs.includes('inferred') ? 'inferred' : 'precise');

function toTracePath(graph: Graph, p: GraphPath): TracePath {
  const nodes = p.nodes.map((id) => describe(graph, id));
  const steps: TraceStep[] = p.edges.map((e, i) => ({
    from: nodes[i]!.name,
    to: nodes[i + 1]!.name,
    kind: e.kind,
    at: { path: e.at.path, line: e.at.line, column: e.at.column },
    confidence: e.confidence,
    kindConfidence: e.kindConfidence,
    source: e.source,
  }));
  const sources = new Set(steps.flatMap((s) => s.source.split(',')));
  return {
    length: steps.length,
    confidence: lowest(steps.map((s) => s.confidence)),
    kindConfidence: lowest(steps.map((s) => s.kindConfidence)),
    source: [...sources].sort().join(','),
    nodes,
    steps,
  };
}

export function trace(store: GraphStore, from: string, to: string, follow: string, depth: number, limit: number): TraceBody {
  if (follow !== 'calls' && follow !== 'all') throw new UserError(`trace: follow는 calls 또는 all이어야 해요: ${follow}`);
  const head = { query: { from, to }, follow, depth } as const;
  const graph = Graph.load(store, { kinds: FOLLOW_KINDS[follow] });
  const a = resolve(store, graph, from);
  const b = resolve(store, graph, to);
  const notFound = (
    [
      ['from', a],
      ['to', b],
    ] as const
  )
    .filter(([, r]) => r.status === 'not_found')
    .map(([side]) => side);
  if (notFound.length > 0) return { ...head, status: 'not_found', notFound };
  if (a.status === 'ambiguous' || b.status === 'ambiguous') {
    const candidates: TraceBody['candidates'] = {};
    if (a.status === 'ambiguous') candidates.from = a.candidates;
    if (b.status === 'ambiguous') candidates.to = b.candidates;
    return { ...head, status: 'ambiguous', candidates };
  }
  if (a.status !== 'found' || b.status !== 'found') throw new Error('도달할 수 없음');

  const targets = new Set(b.ids);
  const starts = a.ids.filter((id) => !targets.has(id));
  if (starts.length === 0) throw new UserError(`trace: from과 to가 같은 곳이에요: ${from}`);
  const search = graph.paths(starts, b.ids, { maxDepth: depth, cap: PATH_CAP });
  const all = search.paths.map((p) => toTracePath(graph, p));
  const paths = { ...page(all.slice(0, limit), all.length), capped: search.capped };
  const ends = { from: a.node, to: b.node };
  if (all.length > 0) return { ...head, status: 'found', ...ends, paths };

  // 길이 없을 때: depth 밖에는 있는지, 거꾸로는 이어지는지 알려 줘요(물음을 고칠 실마리).
  const body: TraceBody = { ...head, status: 'no_path', ...ends, paths };
  const beyond = graph.reach(starts, 'out', Infinity).find((r) => targets.has(r.node));
  if (beyond) body.shortestBeyondDepth = beyond.distance;
  body.reverse = graph.reach([...targets], 'out', Infinity).some((r) => r.distance > 0 && a.ids.includes(r.node));
  return body;
}

export const traceQuery: QueryDef = {
  name: 'trace',
  description:
    '두 지점(이름 또는 파일) 사이의 경로를 돌려줘요: from이 어떤 호출(또는 참조·import)을 거쳐 to까지 가는지. "이 버튼이 어떻게 저 함수까지 가나"에 답해요. ' +
    '가장 짧은 경로가 먼저, 다른 경로가 짧은 순으로 limit개까지 나와요. 구간마다 관계 종류(kind)와 적힌 자리(at), 믿음(confidence: 관계가 있는지, kindConfidence: 종류가 맞는지)이 붙고, 경로의 믿음은 구간 가운데 가장 낮은 것이에요. ' +
    '이름은 그 안의 멤버까지, 파일은 그 파일이 정의한 이름까지 지점에 넣어요. 길이 없으면 status가 no_path이고, 거꾸로 이어지는지(reverse)와 depth 밖의 가장 짧은 길이(shortestBeyondDepth)를 알려 줘요. ' +
    '같은 이름이 여럿이면 고르지 않고 후보(candidates)를 돌려주니 qualifiedName이나 key로 다시 물어요.',
  params: [
    {
      name: 'from',
      type: 'string',
      positional: true,
      required: true,
      description: '출발 지점. 짧은 이름(OrderButton), 바깥 타입을 붙인 이름(Cart.add), 심볼 열쇠(key), 저장소 기준 파일 경로 중 하나.',
    },
    { name: 'to', type: 'string', required: true, description: '도착 지점. from과 같은 꼴.' },
    {
      name: 'follow',
      type: 'string',
      default: 'calls',
      description: '따라갈 관계. calls: 호출만(기본). all: 참조·읽기·쓰기·상속·구현·import까지 모두.',
    },
    { name: 'depth', type: 'integer', min: 1, default: 10, description: '경로의 가장 긴 길이(구간 수).' },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '경로를 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) =>
    trace(store, args.from as string, args.to as string, args.follow as string, args.depth as number, args.limit as number),
};
