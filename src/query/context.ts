// context: 이름 하나의 정의 위치, 종류, 사용처. 이름이 여럿에 맞으면 고르지 않고 후보를 돌려줘요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { DEFAULT_LIMIT, page, type Page } from '../answer.ts';
import type { GraphStore, SymbolRow, UseRow } from '../graph/store.ts';
import type { QueryDef } from '../queries.ts';

/** context 답의 몸통. */
export interface ContextBody {
  [key: string]: unknown;
  query: string;
  status: 'found' | 'ambiguous' | 'not_found';
  symbol?: Omit<SymbolRow, 'key'>;
  uses?: Page<UseRow>;
  /** status가 ambiguous일 때. 각 후보의 qualifiedName이나 key로 다시 물어요. */
  candidates?: SymbolRow[];
}

export function context(store: GraphStore, query: string, limit: number): ContextBody {
  const found = store.findSymbols(query);
  if (found.length === 0) return { query, status: 'not_found' };
  if (found.length > 1) return { query, status: 'ambiguous', candidates: found };
  const { key, ...symbol } = found[0]!;
  const uses = store.usesOf(key, limit);
  return { query, status: 'found', symbol, uses: page(uses.items, uses.total) };
}

export const contextQuery: QueryDef = {
  name: 'context',
  description:
    '이름(심볼) 하나의 정의 위치, 종류, 사용처를 돌려줘요. 같은 이름이 여럿이면 하나를 고르지 않고 후보(candidates)를 돌려주니, 후보의 qualifiedName이나 key로 다시 물어요.',
  params: [
    {
      name: 'query',
      type: 'string',
      positional: true,
      required: true,
      description: '찾을 이름. 짧은 이름(withTax), 바깥 타입을 붙인 이름(Cart.add), 심볼 열쇠(key) 중 하나.',
    },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '사용처를 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) => context(store, args.query as string, args.limit as number),
};
