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
}

function push(map: Map<NodeId, EdgeRow[]>, key: NodeId, edge: EdgeRow): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}
