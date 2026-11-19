// 그래프 탐색: 저장소의 간선(GraphStore.edges)을 메모리의 인접 목록으로 올려 거리별로 따라가요.
// impact(거슬러 올라가기), trace(두 지점 사이 경로), clusters(묶음)가 함께 써요. 언어를 몰라요.
import type { Confidence, FileRole, RelationKind } from '../facts.ts';
import type { DefinitionRow, EdgeRow, GraphStore, NodeRef } from './store.ts';

/** 노드 id. 심볼은 `s:<열쇠>`, 파일은 `f:<경로>`. */
export type NodeId = string;

export function nodeId(ref: NodeRef): NodeId {
  return 'symbol' in ref ? `s:${ref.symbol}` : `f:${ref.file}`;
}

/** 노드 하나의 정보. 파일 노드는 symbol이 없어요. */
export interface NodeInfo {
  id: NodeId;
  /** 심볼이면 바깥 타입을 붙인 이름, 파일이면 경로. */
  label: string;
  /** 정의가 있는 파일(파일 노드면 그 파일). */
  path: string;
  role: FileRole;
  symbol?: DefinitionRow;
}

export interface GraphOptions {
  /** 따라갈 관계 종류. 없으면 모두. 예: trace의 "호출만"은 ['call']. */
  kinds?: RelationKind[];
}

/** 한 노드에 도착한 거리와, 그 거리를 처음 만든 간선. */
export interface Reached {
  node: NodeId;
  /** 출발점은 0, 직접 닿은 곳은 1, … */
  distance: number;
  /** 출발점이면 없음. */
  via?: { from: NodeId; edge: EdgeRow };
  /** 출발점에서 여기까지 오는 길에 추정 관계(confidence가 inferred)가 하나라도 있으면 inferred. */
  confidence: Confidence;
}

export class Graph {
  private readonly outEdges = new Map<NodeId, EdgeRow[]>();
  private readonly inEdges = new Map<NodeId, EdgeRow[]>();
  private readonly nodes = new Map<NodeId, NodeInfo>();

  private constructor() {}

  /** 저장소의 간선과 정의를 읽어 그래프를 만들어요. 파일 노드는 색인된 파일마다 하나씩 있어요. */
  static load(store: GraphStore, options: GraphOptions = {}): Graph {
    const g = new Graph();
    const roles = new Map<string, FileRole>();
    for (const path of store.filePaths()) {
      const file = store.findFile(path);
      const role = file?.role ?? 'app';
      roles.set(path, role);
      g.nodes.set(nodeId({ file: path }), { id: nodeId({ file: path }), label: path, path, role });
    }
    for (const d of store.definitions()) {
      const id = nodeId({ symbol: d.key });
      const path = d.definition.path;
      g.nodes.set(id, { id, label: d.qualifiedName, path, role: roles.get(path) ?? 'app', symbol: d });
    }
    for (const e of store.edges(options.kinds ? { kinds: options.kinds } : {})) {
      const from = nodeId(e.from);
      const to = nodeId(e.to);
      if (from === to) continue;
      push(g.outEdges, from, e);
      push(g.inEdges, to, e);
    }
    return g;
  }

  node(id: NodeId): NodeInfo | undefined {
    return this.nodes.get(id);
  }

  allNodes(): NodeInfo[] {
    return [...this.nodes.values()];
  }

  /** 이 노드에서 나가는 간선(이 노드가 쓰는 것). */
  out(id: NodeId): EdgeRow[] {
    return this.outEdges.get(id) ?? [];
  }

  /** 이 노드로 들어오는 간선(이 노드를 쓰는 것). */
  in(id: NodeId): EdgeRow[] {
    return this.inEdges.get(id) ?? [];
  }

  /** 파일 하나와 그 파일이 정의한 심볼의 노드. 파일을 출발점으로 삼을 때 써요. */
  fileNodes(path: string): NodeId[] {
    const ids = [nodeId({ file: path })];
    for (const n of this.nodes.values()) if (n.symbol && n.path === path) ids.push(n.id);
    return ids;
  }

  /**
   * 출발점들에서 너비 우선으로 따라가요. direction이 'in'이면 쓰는 쪽으로 거슬러 올라가고(impact),
   * 'out'이면 쓰이는 쪽으로 내려가요(trace). maxDepth까지만 가요.
   * 같은 거리에서는 정밀한 길을 추정한 길보다 먼저 골라요. 결과는 거리, 그 안에서 id 순이에요.
   */
  reach(starts: NodeId[], direction: 'in' | 'out', maxDepth: number): Reached[] {
    const seen = new Map<NodeId, Reached>();
    let frontier: NodeId[] = [];
    for (const s of [...new Set(starts)].sort()) {
      seen.set(s, { node: s, distance: 0, confidence: 'precise' });
      frontier.push(s);
    }
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next = new Map<NodeId, Reached>();
      for (const from of frontier) {
        const base = seen.get(from)!;
        for (const edge of direction === 'in' ? this.in(from) : this.out(from)) {
          const to = nodeId(direction === 'in' ? edge.from : edge.to);
          if (seen.has(to)) continue;
          const confidence: Confidence =
            base.confidence === 'inferred' || edge.confidence === 'inferred' ? 'inferred' : 'precise';
          const prev = next.get(to);
          if (!prev || (prev.confidence === 'inferred' && confidence === 'precise')) {
            next.set(to, { node: to, distance: depth, via: { from, edge }, confidence });
          }
        }
      }
      for (const r of next.values()) seen.set(r.node, r);
      frontier = [...next.keys()].sort();
    }
    return [...seen.values()].sort((a, b) => a.distance - b.distance || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  }

  /** 이 노드와 그 안에 정의된 심볼(멤버, 멤버의 멤버 …). 심볼 하나를 출발점·도착점으로 삼을 때 써요. */
  members(id: NodeId): NodeId[] {
    const children = new Map<NodeId, NodeId[]>();
    for (const n of this.nodes.values()) {
      if (!n.symbol?.parentKey) continue;
      const parent = nodeId({ symbol: n.symbol.parentKey });
      const list = children.get(parent);
      if (list) list.push(n.id);
      else children.set(parent, [n.id]);
    }
    const found = new Set<NodeId>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (found.has(cur)) continue;
      found.add(cur);
      queue.push(...(children.get(cur) ?? []));
    }
    return [...found].sort();
  }

  /**
   * starts에서 targets까지 out 방향(쓰는 쪽 → 쓰이는 쪽)으로 가는 단순 경로(같은 노드를 두 번 지나지 않음)를 짧은 것부터 찾아요.
   * 경로는 targets에 처음 닿는 곳에서 끝나고, 중간에 다른 출발점을 지나지 않아요(그 출발점에서 시작하는 더 짧은 경로가 따로 있어요).
   * 두 노드 사이에 간선이 여럿이면 하나만 대표로 골라요: 정밀한 관계, 종류가 정밀한 관계, 적힌 자리(경로, 줄, 열) 순.
   * 순서는 길이, 같은 길이면 지나는 노드 id의 사전 순이라 다시 돌려도 같아요.
   */
  paths(starts: NodeId[], targets: NodeId[], options: PathOptions): PathSearch {
    const startSet = new Set(starts);
    const targetSet = new Set(targets);
    // 도착점까지 남은 가장 짧은 거리. 남은 길이로 닿을 수 없는 노드는 들어가지 않아요(가지치기).
    const toTarget = new Map<NodeId, number>();
    for (const r of this.reach(targets, 'in', options.maxDepth)) toTarget.set(r.node, r.distance);
    // 노드마다 다음 노드(id 순)와 대표 간선. 한 번 만들어 두고 여러 길이에서 다시 써요.
    const nextCache = new Map<NodeId, [NodeId, EdgeRow][]>();
    const nextOf = (u: NodeId): [NodeId, EdgeRow][] => {
      let list = nextCache.get(u);
      if (!list) {
        const best = new Map<NodeId, EdgeRow>();
        for (const e of this.out(u)) {
          const v = nodeId(e.to);
          const prev = best.get(v);
          if (!prev || compareEdges(e, prev) < 0) best.set(v, e);
        }
        list = [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        nextCache.set(u, list);
      }
      return list;
    };
    const found: GraphPath[] = [];
    let capped = false;
    const onPath = new Set<NodeId>();
    const nodes: NodeId[] = [];
    const edges: EdgeRow[] = [];
    // 길이가 정확히 remaining만큼 남은 경로를 id 순으로 따라가요. 그러면 찾는 순서가 곧 답의 순서예요.
    const walk = (u: NodeId, remaining: number): void => {
      for (const [v, e] of nextOf(u)) {
        if (capped) return;
        if (onPath.has(v)) continue;
        if (targetSet.has(v)) {
          if (remaining !== 1) continue;
          if (found.length >= options.cap) {
            capped = true;
            return;
          }
          found.push({ nodes: [...nodes, v], edges: [...edges, e] });
          continue;
        }
        if (startSet.has(v)) continue;
        const d = toTarget.get(v);
        if (d === undefined || d > remaining - 1) continue;
        onPath.add(v);
        nodes.push(v);
        edges.push(e);
        walk(v, remaining - 1);
        onPath.delete(v);
        nodes.pop();
        edges.pop();
      }
    };
    const sortedStarts = [...startSet].filter((s) => !targetSet.has(s)).sort();
    for (let length = 1; length <= options.maxDepth && !capped; length++) {
      for (const s of sortedStarts) {
        if (capped) break;
        const d = toTarget.get(s);
        if (d === undefined || d > length) continue;
        onPath.add(s);
        nodes.push(s);
        walk(s, length);
        onPath.delete(s);
        nodes.pop();
      }
    }
    return { paths: found, capped };
  }
}

/** 두 지점 사이 경로 하나. edges[i]가 nodes[i]에서 nodes[i + 1]로 가요. */
export interface GraphPath {
  nodes: NodeId[];
  edges: EdgeRow[];
}

/** paths()의 결과. paths는 짧은 순, 같은 길이면 지나는 노드 id의 사전 순이에요. */
export interface PathSearch {
  paths: GraphPath[];
  /** 상한(cap)에 닿아 더 세지 않았으면 true. 그때 paths.length는 cap이고 실제 경로는 더 있어요. */
  capped: boolean;
}

export interface PathOptions {
  /** 경로의 가장 긴 길이(간선 수). */
  maxDepth: number;
  /** 이만큼 찾으면 멈춰요. 경로 수가 폭발하는 큰 그래프를 막아요. */
  cap: number;
}

const RANK: Record<Confidence, number> = { precise: 0, inferred: 1 };

/** 같은 두 노드 사이 간선 중 대표를 고르는 순서. */
function compareEdges(a: EdgeRow, b: EdgeRow): number {
  return (
    RANK[a.confidence] - RANK[b.confidence] ||
    RANK[a.kindConfidence] - RANK[b.kindConfidence] ||
    (a.at.path < b.at.path ? -1 : a.at.path > b.at.path ? 1 : 0) ||
    a.at.line - b.at.line ||
    a.at.column - b.at.column ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  );
}

function push(map: Map<NodeId, EdgeRow[]>, key: NodeId, edge: EdgeRow): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}
