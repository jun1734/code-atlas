// context: 이름 하나의 정의 위치, 종류, 사용처. 이름이 여럿에 맞으면 고르지 않고 후보를 돌려줘요.
import { isStale } from '../freshness.ts';
import type { GraphStore, SymbolRow, UseRow } from '../graph/store.ts';

export interface ContextAnswer {
  /** 색인 기준 커밋과, 그 뒤로 바뀐 것이 있는지(stale). */
  index: { commit: string | null; indexedAt: string; stale: boolean | null };
  query: string;
  status: 'found' | 'ambiguous' | 'not_found';
  symbol?: Omit<SymbolRow, 'key'>;
  uses?: { total: number; truncated: boolean; items: UseRow[] };
  /** status가 ambiguous일 때. 각 후보의 qualifiedName이나 key로 다시 물어요. */
  candidates?: SymbolRow[];
}

export function context(store: GraphStore, query: string, limit: number): ContextAnswer {
  const meta = store.meta();
  const base = { index: { commit: meta.commit, indexedAt: meta.indexedAt, stale: isStale(meta) }, query };
  const found = store.findSymbols(query);
  if (found.length === 0) return { ...base, status: 'not_found' };
  if (found.length > 1) return { ...base, status: 'ambiguous', candidates: found };
  const { key, ...symbol } = found[0]!;
  const uses = store.usesOf(key, limit);
  return {
    ...base,
    status: 'found',
    symbol,
    uses: { total: uses.total, truncated: uses.items.length < uses.total, items: uses.items },
  };
}
