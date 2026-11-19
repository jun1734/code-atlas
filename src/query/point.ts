// 지점: 질의가 받는 "이름 또는 파일"을 그래프의 한 곳으로 풀고, 답에 그 곳을 적는 꼴.
// context, impact, trace가 같은 해석기(resolvePoint)와 같은 서술(pointOfSymbol, pointOfNode)을 써요.
import type { Confidence, SymbolKind } from '../facts.ts';
import type { FileRow, GraphStore, Location, SymbolRow } from '../graph/store.ts';
import type { NodeInfo } from '../graph/traverse.ts';

/** 물은 글을 푼 결과. 파일이 먼저, 아니면 이름(key → qualifiedName → name 순으로 처음 맞는 단계). */
export type Resolved =
  | { status: 'file'; file: FileRow }
  | { status: 'symbol'; symbol: SymbolRow }
  | { status: 'ambiguous'; candidates: SymbolRow[] }
  | { status: 'not_found' };

/**
 * 물은 글이 색인된 파일 경로와 정확히 맞으면 그 파일(Windows의 '\'는 '/'로 바꿔요), 아니면 이름으로 찾은 심볼.
 * 이름이 여럿에 맞으면 고르지 않고 후보를, 없으면 not_found를 돌려줘요.
 */
export function resolvePoint(store: GraphStore, query: string): Resolved {
  const file = store.findFile(query.replaceAll('\\', '/'));
  if (file) return { status: 'file', file };
  const found = store.findSymbols(query);
  if (found.length === 0) return { status: 'not_found' };
  if (found.length > 1) return { status: 'ambiguous', candidates: found };
  return { status: 'symbol', symbol: found[0]! };
}

/**
 * 답에 적는 지점 하나. 심볼이면 정의 위치와 key, 정의를 낸 색인기의 표시(confidence, source)가 붙어요.
 * 파일이면 name이 경로이고 표시가 없어요(파일 지점은 계약의 예외: docs/contract.md 약속 3).
 */
export interface Point {
  name: string;
  kind: SymbolKind;
  path: string;
  line?: number;
  column?: number;
  key?: string;
  confidence?: Confidence;
  source?: string;
}

export function pointOfSymbol(s: SymbolRow): Point {
  const d = s.definition;
  return { name: s.qualifiedName, kind: s.kind, path: d.path, line: d.line, column: d.column, key: s.key, confidence: s.confidence, source: s.source };
}

export function pointOfFile(path: string): Point {
  return { name: path, kind: 'file', path };
}

/** 그래프 노드를 지점으로. */
export function pointOfNode(n: NodeInfo): Point {
  return n.symbol ? pointOfSymbol(n.symbol) : pointOfFile(n.path);
}

/** 적힌 자리에서 답에 쓰는 칸(경로, 줄, 열)만 남겨요. */
export function locationOf(at: Location): Location {
  return { path: at.path, line: at.line, column: at.column };
}
