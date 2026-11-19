// context: 이름 하나의 정의 위치, 종류, 사용처. 이름이 여럿에 맞으면 고르지 않고 후보를 돌려줘요.
// 파일 경로를 물으면 그 파일이 정의하는 이름, 가져다 쓰는 파일, 쓰이는 파일을 돌려줘요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { DEFAULT_LIMIT, page, type Page, type Sourced } from '../answer.ts';
import type { FileRole } from '../facts.ts';
import type { FileLink, FileRow, GraphStore, SymbolRow, UseRow } from '../graph/store.ts';
import type { QueryDef } from '../queries.ts';

/** 사용처 목록. 앱 코드가 먼저, 테스트가 뒤에 오고, byRole에 역할별 전체 개수가 있어요. */
export type Uses = Page<UseRow> & { byRole: Record<FileRole, number> };

/** context 답의 몸통. */
export interface ContextBody {
  [key: string]: unknown;
  query: string;
  status: 'found' | 'ambiguous' | 'not_found';
  symbol?: Omit<SymbolRow, 'key'>;
  uses?: Uses;
  /** status가 ambiguous일 때. 각 후보의 qualifiedName이나 key로 다시 물어요. */
  candidates?: SymbolRow[];
  /** 파일을 물었을 때: 그 파일. */
  file?: FileRow;
  /** 파일이 정의하는 이름. key로 다시 물을 수 있어요. */
  defines?: Page<SymbolRow>;
  /** 파일이 가져오거나 다시 내보내는 저장소 안의 파일. */
  imports?: Page<FileLink>;
  /** 파일을 가져오거나 다시 내보내는 파일. */
  importedBy?: Page<FileLink>;
  /** 파일이 정의한 이름을 쓰는 다른 파일과 사용처 수(barrel을 거친 것 포함). */
  usedBy?: Page<FileLink & { uses: number }>;
}

/** 목록 전체에서 앞의 limit개만 잘라 Page로. */
function cut<T extends Sourced>(all: T[], limit: number): Page<T> {
  return page(all.slice(0, limit), all.length);
}

export function context(store: GraphStore, query: string, limit: number): ContextBody {
  // 경로는 '/'로 적어요. Windows에서 '\'로 물어도 찾게 바꿔요.
  const file = store.findFile(query.replaceAll('\\', '/'));
  if (file) {
    return {
      query,
      status: 'found',
      file,
      defines: cut(store.definedIn(file.path), limit),
      imports: cut(store.importsOf(file.path), limit),
      importedBy: cut(store.importersOf(file.path), limit),
      usedBy: cut(store.usersOf(file.path), limit),
    };
  }
  const found = store.findSymbols(query);
  if (found.length === 0) return { query, status: 'not_found' };
  if (found.length > 1) return { query, status: 'ambiguous', candidates: found };
  const { key, ...symbol } = found[0]!;
  const uses = store.usesOf(key, limit);
  return { query, status: 'found', symbol, uses: { ...page(uses.items, uses.total), byRole: uses.byRole } };
}

export const contextQuery: QueryDef = {
  name: 'context',
  description:
    '이름(심볼) 하나의 정의 위치, 종류, 사용처를 돌려줘요. 사용처마다 앱 코드인지 테스트인지(role)와 읽기·쓰기·호출·상속·구현 중 무엇인지(kind, 그 믿음은 kindConfidence)가 붙어요. ' +
    '같은 이름이 여럿이면 하나를 고르지 않고 후보(candidates)를 돌려주니, 후보의 qualifiedName이나 key로 다시 물어요. ' +
    '저장소 기준 파일 경로를 주면 그 파일이 정의하는 이름, 가져다 쓰는 파일, 쓰이는 파일을 돌려줘요.',
  params: [
    {
      name: 'query',
      type: 'string',
      positional: true,
      required: true,
      description:
        '찾을 이름이나 파일. 짧은 이름(withTax), 바깥 타입을 붙인 이름(Cart.add), 심볼 열쇠(key), 저장소 기준 파일 경로(lib/src/cart.dart) 중 하나.',
    },
    {
      name: 'limit',
      type: 'integer',
      min: 1,
      default: DEFAULT_LIMIT,
      description: '목록(사용처, 파일이 정의하는 이름, 파일 목록)마다 앞에서부터 몇 개까지 줄지.',
    },
  ],
  run: (store, args) => context(store, args.query as string, args.limit as number),
};
