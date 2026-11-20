// 이름 단위 그래프 화면에 넣을 자료. 이름(심볼)과 파일마다 search·context·impact 질의의 답을 그대로 받아 짧은 꼴로 담아요.
// 여기서 사용처나 영향 범위를 다시 계산하지 않아요. 화면은 이 자료만으로 돌아서(네트워크 없이) 이웃을 눌러 따라갈 수 있어요.
// 칸 이름이 짧고 목록이 배열(튜플)인 건 큰 저장소(이름 수천 개)에서도 HTML 한 장에 들어가게 하려고서예요.
import { basename } from 'node:path';
import type { Confidence } from '../facts.ts';
import type { GraphStore, SymbolRow } from '../graph/store.ts';
import { context } from '../query/context.ts';
import { DEFAULT_DEPTH, DEFAULT_HOT_USES, impact, type ImpactItem, prepareImpact } from '../query/impact.ts';
import { search } from '../query/search.ts';

/** 이름마다 담는 사용처 수(context의 limit). 전체 개수는 따로 담아 화면에 "더 있음"을 보여요. */
export const GRAPH_USES_LIMIT = 50;
/** 이름마다 담는 영향 받는 곳 수(impact의 limit). */
export const GRAPH_AFFECTED_LIMIT = 80;

/**
 * 잘린 목록: [전체 개수, 항목들].
 */
type Cut<T> = [number, T[]];

/**
 * 노드 하나(이름 또는 파일). 노드는 배열의 자리(번호)로 서로 가리켜요.
 * 순서: search 답의 순서(많이 쓰이는 것이 먼저)인 이름들, 그다음 경로 순의 파일들, 그다음 영향 범위에서 만난 그 밖의 정의.
 */
export interface GraphNode {
  /** 심볼 열쇠(key). 파일이면 없어요. */
  k?: string;
  /** 짧은 이름(파일이면 파일 이름). */
  n: string;
  /** 바깥 타입을 붙인 이름(파일이면 경로). */
  q: string;
  /** 종류(function, class, …, file). */
  d: string;
  /** 정의가 있는 파일(paths의 번호). */
  p: number;
  /** 정의의 줄과 열(1부터). 파일이면 없어요. */
  l?: number;
  c?: number;
  /** 사용처 수(search의 uses). 파일이면 없어요. */
  u?: number;
  /** 1이면 추정(inferred). 없으면 정밀. 파일 노드는 표시가 없어요(계약의 파일 지점). */
  i?: 1;
  /** 정의를 낸 색인기(sources의 번호). 파일이면 없어요. */
  s?: number;
  /** 1이면 테스트 파일에 있어요. */
  t?: 1;
  /**
   * 사용처(context의 uses): [전체, [경로 번호, 줄, 열, 관계 종류, 종류가 추정이면 1, 추정이면 1, 출처 번호, 테스트면 1, 감싸는 이름?]].
   * 심볼에만 있어요.
   */
  U?: Cut<(string | number)[]>;
  /**
   * 영향 범위(impact의 affected): [전체, depth 다음에도 있으면 1, [노드 번호, 거리, via 노드 번호(거리 1이면 -1), 관계, 추정이면 1, 출처 번호],
   * 거리별 전체 개수(impact의 summary.byDistance)]. 항목은 앞에서부터 잘려서 먼 거리는 일부만 담길 수 있어 거리별 전체를 따로 담아요.
   * via는 한 단계 가까운 노드예요(impact 답의 via.name과 같은 이름). 찾지 못하면 -1.
   */
  A?: [number, 0 | 1, (string | number)[][], Record<string, number>];
  /** 파일만: context 파일 답의 네 목록. 파일 목록 항목은 [파일 노드 번호, 추정이면 1, 출처 번호, (usedBy만) 사용처 수]. */
  F?: {
    defines: Cut<number>;
    imports: Cut<number[]>;
    importedBy: Cut<number[]>;
    usedBy: Cut<number[]>;
  };
}

export interface GraphData {
  title: string;
  repo: string;
  head: string | null;
  commit: string | null;
  branch: string | null;
  date: string;
  /** 코드 지도 HTML의 파일 이름(같은 폴더). 파일 노드에서 지도로 이어요. */
  map: string;
  /** impact를 물은 깊이와 hot 기준, 목록마다 담은 개수. */
  depth: number;
  hotUses: number;
  limits: { uses: number; affected: number };
  paths: string[];
  sources: string[];
  nodes: GraphNode[];
}

const flag = (c: Confidence): 0 | 1 => (c === 'inferred' ? 1 : 0);

export interface GraphMeta {
  head: string | null;
  commit: string | null;
  branch: string | null;
  date: string;
  map: string;
  config?: string;
}

/** 그래프와 저장소 설정으로 그래프 화면 자료를 만들어요. */
export function symbolGraphData(store: GraphStore, meta: GraphMeta): GraphData {
  const root = store.meta().repoRoot;
  const paths: string[] = [];
  const pathIdx = new Map<string, number>();
  const pathOf = (p: string) => {
    let i = pathIdx.get(p);
    if (i === undefined) pathIdx.set(p, (i = paths.push(p) - 1));
    return i;
  };
  const sources: string[] = [];
  const sourceOf = (s: string) => {
    let i = sources.indexOf(s);
    if (i < 0) i = sources.push(s) - 1;
    return i;
  };

  const nodes: GraphNode[] = [];
  const byKey = new Map<string, number>();
  const byFile = new Map<string, number>();
  const byPlace = new Map<string, number>();
  const place = (path: string, line: number | undefined, name: string) => `${path}\0${line ?? ''}\0${name}`;
  const counts = store.useCounts();
  const addSymbol = (s: SymbolRow, role: string) => {
    const at = s.definition;
    const node: GraphNode = { k: s.key, n: s.name, q: s.qualifiedName, d: s.kind, p: pathOf(at.path), l: at.line, c: at.column, u: counts.get(s.key) ?? 0 };
    if (s.confidence === 'inferred') node.i = 1;
    node.s = sourceOf(s.source);
    if (role === 'test') node.t = 1;
    const i = nodes.push(node) - 1;
    byKey.set(s.key, i);
    byPlace.set(place(at.path, at.line, s.qualifiedName), i);
    return i;
  };

  // 이름: search 답의 순서 그대로(화면의 검색도 이 순서로 보여요).
  for (const row of search(store, { limit: Number.MAX_SAFE_INTEGER }).results.items) addSymbol(row, row.role);
  // 파일: 경로 순.
  for (const path of store.filePaths()) {
    const file = store.findFile(path)!;
    const node: GraphNode = { n: basename(path), q: path, d: 'file', p: pathOf(path) };
    if (file.role === 'test') node.t = 1;
    byFile.set(path, nodes.push(node) - 1);
  }
  // 검색에 나오지 않는 정의(영향 범위에서 만날 수 있어요)를 찾을 자리.
  const definitions = new Map(store.definitions().map((d) => [place(d.definition.path, d.definition.line, d.qualifiedName), d]));
  const roleOf = (path: string) => store.findFile(path)?.role ?? 'app';
  const nodeOfItem = (item: ImpactItem): number => {
    if (item.kind === 'file') return byFile.get(item.path) ?? -1;
    const at = place(item.path, item.line, item.name);
    const known = byPlace.get(at);
    if (known !== undefined) return known;
    const def = definitions.get(at);
    if (def) return addSymbol(def, roleOf(item.path));
    // 정의 목록에도 없으면(매개변수 등) 따라갈 수 없는 노드로만 둬요.
    const node: GraphNode = { n: item.name, q: item.name, d: item.kind, p: pathOf(item.path), ...(item.line !== undefined ? { l: item.line } : {}) };
    if (item.role === 'test') node.t = 1;
    const i = nodes.push(node) - 1;
    byPlace.set(at, i);
    return i;
  };
  const nodeOfSymbol = (s: SymbolRow) => byKey.get(s.key) ?? addSymbol(s, roleOf(s.definition.path));
  const fileLinks = <T extends { path: string; confidence: Confidence; source: string; uses?: number }>(list: { total: number; items: T[] }): Cut<number[]> => [
    list.total,
    list.items.map((l) => [byFile.get(l.path) ?? -1, flag(l.confidence), sourceOf(l.source), ...(l.uses !== undefined ? [l.uses] : [])]),
  ];

  const prepared = prepareImpact(store, meta.config);
  const opts = { depth: DEFAULT_DEPTH, limit: GRAPH_AFFECTED_LIMIT, hotUses: DEFAULT_HOT_USES, config: meta.config };
  // 노드는 돌면서 늘 수 있어요(영향 범위에서 만난 정의). 늘어난 노드도 끝까지 채워요.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const query = node.k ?? (node.d === 'file' ? node.q : undefined);
    if (query === undefined) continue;
    if (node.k !== undefined) {
      const ctx = context(store, query, GRAPH_USES_LIMIT);
      if (ctx.uses) {
        node.U = [
          ctx.uses.total,
          ctx.uses.items.map((u) => {
            const row: (string | number)[] = [pathOf(u.path), u.line, u.column, u.kind, flag(u.kindConfidence), flag(u.confidence), sourceOf(u.source), u.role === 'test' ? 1 : 0];
            if (u.in !== undefined) row.push(u.in);
            return row;
          }),
        ];
      }
    } else {
      const ctx = context(store, query, GRAPH_USES_LIMIT);
      node.F = {
        defines: [ctx.defines!.total, ctx.defines!.items.map(nodeOfSymbol)],
        imports: fileLinks(ctx.imports!),
        importedBy: fileLinks(ctx.importedBy!),
        usedBy: fileLinks(ctx.usedBy!),
      };
    }
    const imp = impact(store, query, opts, prepared);
    if (imp.status !== 'found') continue;
    const items = imp.affected!.items;
    const ids = items.map(nodeOfItem);
    node.A = [
      imp.summary!.affected,
      imp.summary!.moreBeyondDepth ? 1 : 0,
      items.map((item, j) => {
        // via: 한 단계 가까운 곳 가운데 이름이 같은 것. 거리 1은 고른 노드 자신(또는 그 멤버)이에요.
        let via = -1;
        if (item.distance > 1) {
          const k = items.findIndex((o) => o.distance === item.distance - 1 && o.name === item.via.name);
          if (k >= 0) via = ids[k]!;
        }
        return [ids[j]!, item.distance, via, item.via.relation, flag(item.confidence), sourceOf(item.source)];
      }),
      imp.summary!.byDistance,
    ];
  }

  return {
    title: `${basename(root)} 이름 그래프`,
    repo: basename(root),
    head: meta.head,
    commit: meta.commit,
    branch: meta.branch,
    date: meta.date,
    map: meta.map,
    depth: DEFAULT_DEPTH,
    hotUses: DEFAULT_HOT_USES,
    limits: { uses: GRAPH_USES_LIMIT, affected: GRAPH_AFFECTED_LIMIT },
    paths,
    sources,
    nodes,
  };
}
