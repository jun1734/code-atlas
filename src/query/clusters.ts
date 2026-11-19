// clusters: 서로 촘촘히 엮인 이름들의 묶음. 폴더 구조(모듈)와 실제 결합이 어긋난 곳을 찾는 데 써요.
//
// 알고리즘: Louvain 방법(모듈성 최대화). V. D. Blondel, J.-L. Guillaume, R. Lambiotte, E. Lefebvre,
// "Fast unfolding of communities in large networks", J. Stat. Mech. (2008) P10008.
// 라이브러리 없이 직접 구현했어요. 난수를 쓰지 않고 노드를 id 순으로 훑어서, 같은 색인이면 늘 같은 묶음이 나와요.
// Louvain은 이어지지 않은 묶음을 낼 수 있어서(Traag 등 2019, Leiden 논문이 짚은 문제) 마지막에 묶음마다
// 이어진 조각으로 나눠요.
//
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { compareText, cut, DEFAULT_LIMIT, type InnerList, type Page, type Sourced, sourcedOf } from '../answer.ts';
import type { SymbolKind } from '../facts.ts';
import type { GraphStore, Location } from '../graph/store.ts';
import { Graph, type NodeInfo, nodeId } from '../graph/traverse.ts';
import { repoModules } from '../modules.ts';
import type { QueryDef } from '../queries.ts';
import { CONFIG_PARAM } from '../repo-config.ts';
import { pointOfNode } from './point.ts';

export interface ClusterItem extends Sourced {
  /** 든 이름(최상위 선언) 수. */
  size: number;
  /** 묶음 안에서 가장 많이 엮인 이름. */
  representative: { name: string; kind: SymbolKind; definition: Location };
  /** 든 이름(바깥 타입을 붙인 이름), 이름순. */
  names: InnerList<string>;
  /** 이름이 정의된 파일, 경로순. */
  files: InnerList<string>;
  /** 파일들이 든 모듈(저장소 설정 기준), 이름순. 어느 모듈에도 안 든 파일은 빠져요. */
  modules: string[];
  /** 모듈이 둘 이상이면 true. 폴더 구조와 결합이 어긋났을 수 있는 곳이에요. */
  crossModule: boolean;
  /** 묶음 안 이름 사이의 관계 수. */
  internalEdges: number;
  /** 묶음 밖 이름과의 관계 수. */
  externalEdges: number;
}

export interface ClustersBody {
  [key: string]: unknown;
  config: string | null;
  summary: {
    /** 묶음을 셈한 이름(앱 코드의 최상위 선언) 수. */
    names: number;
    /** 둘 이상이 든 묶음 수. */
    clusters: number;
    /** 어느 이름과도 엮이지 않아 혼자 남은 이름 수(목록에 나오지 않아요). */
    singletons: number;
    /** 여러 모듈에 걸친 묶음 수. */
    crossModule: number;
    /** 나눈 결과의 모듈성(Q, -0.5~1). 높을수록 묶음 안이 촘촘하고 묶음 사이가 성겨요. */
    modularity: number;
  };
  /** 둘 이상이 든 묶음, 큰 것부터(같으면 대표 이름순). */
  clusters: Page<ClusterItem>;
}

/** 무게 있는 무향 그래프. 노드는 0..n-1. */
interface Weighted {
  n: number;
  /** 이웃 → 무게. 자기 고리(self loop)는 adj[i].get(i)에 두 번 센 무게(2w)로 둬요. */
  adj: Map<number, number>[];
}

/** 노드 i의 무게 합(자기 고리는 두 번). */
const degreeOf = (g: Weighted, i: number) => {
  let k = 0;
  for (const w of g.adj[i]!.values()) k += w;
  return k;
};

/**
 * Louvain 1단계: 노드를 하나씩 옮겨 모듈성이 오르는 동안 되풀이해요. 노드는 0..n-1 순으로 훑어요(결정적).
 * 돌려주는 값은 노드마다의 묶음 번호(0부터 이어 붙인 번호).
 */
function localMoves(g: Weighted, m2: number): { community: number[]; moved: boolean } {
  const community = Array.from({ length: g.n }, (_, i) => i);
  const k = Array.from({ length: g.n }, (_, i) => degreeOf(g, i));
  const tot = [...k];
  let moved = false;
  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 0; i < g.n; i++) {
      const own = community[i]!;
      // i에서 이웃 묶음으로 가는 무게(자기 고리는 빼요).
      const toCommunity = new Map<number, number>();
      for (const [j, w] of g.adj[i]!) {
        if (j === i) continue;
        const c = community[j]!;
        toCommunity.set(c, (toCommunity.get(c) ?? 0) + w);
      }
      tot[own]! -= k[i]!;
      // 모듈성 증가량 ΔQ ∝ k_i,in(C) − k_i·Σtot(C)/2m. 제자리가 기준이고, 더 큰 곳만 골라요(같으면 번호가 작은 곳).
      const gain = (c: number) => (toCommunity.get(c) ?? 0) - (k[i]! * tot[c]!) / m2;
      let best = own;
      let bestGain = gain(own);
      for (const c of [...toCommunity.keys()].sort((a, b) => a - b)) {
        const g2 = gain(c);
        if (g2 > bestGain + 1e-12) {
          best = c;
          bestGain = g2;
        }
      }
      tot[best]! += k[i]!;
      if (best !== own) {
        community[i] = best;
        improved = true;
        moved = true;
      }
    }
  }
  // 번호를 처음 나온 순서대로 0부터 다시 매겨요.
  const renumber = new Map<number, number>();
  return { community: community.map((c) => renumber.get(c) ?? renumber.set(c, renumber.size).get(c)!), moved };
}

/** Louvain 2단계: 묶음 하나를 노드 하나로 접어요. 묶음 안의 무게는 자기 고리가 돼요. */
function aggregate(g: Weighted, community: number[]): Weighted {
  const n = Math.max(-1, ...community) + 1;
  const adj = Array.from({ length: n }, () => new Map<number, number>());
  for (let i = 0; i < g.n; i++) {
    for (const [j, w] of g.adj[i]!) {
      const a = community[i]!;
      const b = community[j]!;
      adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
    }
  }
  return { n, adj };
}

/** Louvain 전체: 더 옮길 것이 없을 때까지 1·2단계를 되풀이하고, 원래 노드마다 묶음 번호를 돌려줘요. */
function louvain(g: Weighted): number[] {
  let m2 = 0;
  for (let i = 0; i < g.n; i++) m2 += degreeOf(g, i);
  let membership = Array.from({ length: g.n }, (_, i) => i);
  if (m2 === 0) return membership;
  let level = g;
  for (;;) {
    const { community, moved } = localMoves(level, m2);
    if (!moved) return membership;
    membership = membership.map((c) => community[c]!);
    level = aggregate(level, community);
  }
}

/** 나눈 결과의 모듈성 Q = Σ_C [ in(C)/2m − (tot(C)/2m)² ]. */
function modularity(g: Weighted, community: number[]): number {
  let m2 = 0;
  const inner = new Map<number, number>();
  const tot = new Map<number, number>();
  for (let i = 0; i < g.n; i++) {
    for (const [j, w] of g.adj[i]!) {
      m2 += w;
      const c = community[i]!;
      tot.set(c, (tot.get(c) ?? 0) + w);
      if (community[j] === c) inner.set(c, (inner.get(c) ?? 0) + w);
    }
  }
  if (m2 === 0) return 0;
  let q = 0;
  for (const [c, t] of tot) q += (inner.get(c) ?? 0) / m2 - (t / m2) ** 2;
  return q;
}

/** 이름을 셈하는 칸: 앱 코드의 최상위 선언(이름 공간 빼고). */
const counts = (n: NodeInfo | undefined): n is NodeInfo => !!n && n.role === 'app' && n.symbol?.kind !== 'namespace';

export function clusters(store: GraphStore, limit: number, configPath?: string): ClustersBody {
  const { config, moduleOf } = repoModules(store, configPath);
  const graph = Graph.load(store);

  // 1. 최상위 선언을 노드로, 그 사이의 관계(어느 방향이든)를 무게로. 테스트 코드와 파일 노드(import)는 빼요.
  const units = graph
    .allNodes()
    .filter((n) => counts(n) && graph.topLevel(n.id)?.id === n.id)
    .sort((a, b) => compareText(a.id, b.id));
  const index = new Map(units.map((u, i) => [u.id, i]));
  const g: Weighted = { n: units.length, adj: units.map(() => new Map<number, number>()) };
  const pairEdges: (Sourced & { a: number; b: number })[] = [];
  for (const from of graph.allNodes()) {
    const a = index.get(graph.topLevel(from.id)?.id ?? '');
    if (a === undefined) continue;
    for (const edge of graph.out(from.id)) {
      if (!('symbol' in edge.to)) continue;
      const b = index.get(graph.topLevel(nodeId(edge.to))?.id ?? '');
      if (b === undefined || a === b) continue;
      g.adj[a]!.set(b, (g.adj[a]!.get(b) ?? 0) + 1);
      g.adj[b]!.set(a, (g.adj[b]!.get(a) ?? 0) + 1);
      pairEdges.push({ a, b, confidence: edge.confidence, source: edge.source });
    }
  }

  // 2. Louvain으로 나누고, 이어지지 않은 묶음은 이어진 조각으로 나눠요.
  const raw = louvain(g);
  const community = splitDisconnected(g, raw);

  // 3. 묶음마다 이름, 파일, 모듈, 대표 이름.
  const members = new Map<number, number[]>();
  community.forEach((c, i) => (members.get(c) ?? members.set(c, []).get(c)!).push(i));
  const items: ClusterItem[] = [];
  let singletons = 0;
  for (const nodes of members.values()) {
    if (nodes.length < 2) {
      singletons++;
      continue;
    }
    const inside = new Set(nodes);
    const c = community[nodes[0]!]!;
    const internal = pairEdges.filter((e) => inside.has(e.a) && inside.has(e.b));
    const external = pairEdges.filter((e) => inside.has(e.a) !== inside.has(e.b)).length;
    // 대표: 묶음 안 이름과 엮인 무게가 가장 큰 것, 같으면 id 순.
    const innerDegree = (i: number) => {
      let k = 0;
      for (const [j, w] of g.adj[i]!) if (community[j] === c) k += w;
      return k;
    };
    const rep = [...nodes].sort((x, y) => innerDegree(y) - innerDegree(x) || x - y)[0]!;
    const repPoint = pointOfNode(units[rep]!);
    const files = [...new Set(nodes.map((i) => units[i]!.path))].sort(compareText);
    const modules = [...new Set(files.map(moduleOf).filter((m): m is string => m !== null))].sort(compareText);
    items.push({
      size: nodes.length,
      representative: {
        name: repPoint.name,
        kind: repPoint.kind,
        definition: { path: repPoint.path, line: repPoint.line!, column: repPoint.column! },
      },
      names: cut(nodes.map((i) => units[i]!.label).sort(compareText), limit),
      files: cut(files, limit),
      modules,
      crossModule: modules.length > 1,
      internalEdges: internal.length,
      externalEdges: external,
      ...sourcedOf(internal),
    });
  }
  items.sort((x, y) => y.size - x.size || compareText(x.representative.name, y.representative.name));

  return {
    config: config.path,
    summary: {
      names: units.length,
      clusters: items.length,
      singletons,
      crossModule: items.filter((i) => i.crossModule).length,
      modularity: Math.round(modularity(g, community) * 1000) / 1000,
    },
    clusters: cut(items, limit),
  };
}

/** 같은 묶음 번호라도 서로 이어지지 않은 노드들은 다른 묶음으로 나눠요(번호는 가장 작은 노드 순). */
function splitDisconnected(g: Weighted, community: number[]): number[] {
  const out = new Array<number>(g.n).fill(-1);
  let next = 0;
  for (let s = 0; s < g.n; s++) {
    if (out[s] !== -1) continue;
    const id = next++;
    out[s] = id;
    const stack = [s];
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (const j of g.adj[i]!.keys()) {
        if (out[j] === -1 && community[j] === community[s]) {
          out[j] = id;
          stack.push(j);
        }
      }
    }
  }
  return out;
}

export const clustersQuery: QueryDef = {
  name: 'clusters',
  description:
    '서로 촘촘히 엮인 이름(최상위 선언)들의 묶음을 보여 줘요: 묶음마다 든 이름과 파일, 대표 이름, 걸친 모듈(여러 모듈이면 crossModule). ' +
    '폴더 구조와 실제 결합이 어긋난 곳(다른 폴더에 있지만 한 덩어리로 움직이는 코드)이나 떼어 낼 수 있는 덩어리를 찾을 때 불러요. ' +
    '앱 코드만 셈하고 테스트 코드는 빼요. 모듈 기준은 저장소 뿌리의 .code-atlas.json이 정해요.',
  params: [
    CONFIG_PARAM,
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '묶음과 묶음 안의 목록(이름, 파일)을 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) => clusters(store, args.limit as number, args.config as string | undefined),
};
