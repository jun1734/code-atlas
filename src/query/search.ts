// search: 정확한 이름을 몰라도 시작점을 찾아요. 이름 일부(대소문자 무시)나 낙타 표기 조각으로 심볼을 찾고,
// 종류·언어·폴더로 좁혀요. 많이 쓰이는 것이 먼저 와요. 임베딩 기반 의미 검색은 하지 않아요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { DEFAULT_LIMIT, page, type Page } from '../answer.ts';
import type { SymbolKind } from '../facts.ts';
import type { GraphStore, SearchFilter, SearchRow } from '../graph/store.ts';
import { UserError } from '../locate.ts';
import type { QueryDef } from '../queries.ts';

/** 검색할 수 있는 심볼 종류(파일과 매개변수는 검색 대상이 아니에요). */
const KINDS: SymbolKind[] = [
  'namespace', 'class', 'interface', 'enum', 'mixin', 'extension', 'type', 'function', 'method',
  'constructor', 'getter', 'setter', 'field', 'variable', 'constant', 'unknown',
];

/** 검색 결과 하나. key를 그대로 context에 넘기면 이 심볼 하나를 찾아요. */
export interface SearchItem extends SearchRow {
  /** 사용처 수(어느 종류의 관계든, context의 uses.total과 같아요). */
  uses: number;
}

/** search 답의 몸통. */
export interface SearchBody {
  [key: string]: unknown;
  query: string | null;
  /** 실제로 건 조건(준 것만). */
  filters: { kind?: SymbolKind[]; language?: string[]; folder?: string };
  /** 사용처가 많은 순, 같으면 경로·줄·열 순. */
  results: Page<SearchItem>;
}

/** 이름을 낱말로 쪼개요: cartProvider → cart, Provider / HTTPServer → HTTP, Server / snake_case → snake, case. */
function words(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

/**
 * 질의가 이름에 맞는지.
 * - 이름 일부: 대소문자를 가리지 않고 이름 안에 들어 있으면 맞아요(cart → GiftCart).
 * - 낙타 표기 조각: 질의를 낱말로 쪼개 각 조각이 이름의 낱말 머리에 차례로 맞으면 맞아요
 *   (cartProv, CP → cartProvider). 건너뛰는 낱말이 있어도 돼요.
 * - 점(.)이 있으면 바깥 타입을 붙인 이름(qualifiedName)에서 이름 일부로 찾아요(Cart.ad → Cart.add).
 */
function matches(query: string, row: SearchRow): boolean {
  const q = query.toLowerCase();
  if (query.includes('.')) return row.qualifiedName.toLowerCase().includes(q);
  if (row.name.toLowerCase().includes(q)) return true;
  // 질의는 대문자마다 새 조각이에요(CP → C, P). 이름처럼 대문자 묶음(HTTP)을 한 낱말로 보지 않아요.
  const pieces = (query.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? []).map((p) => p.toLowerCase());
  // 조각이 하나뿐이면 이름 일부 검사와 같아요.
  if (pieces.length < 2) return false;
  const nameWords = words(row.name).map((w) => w.toLowerCase());
  let at = 0;
  for (const piece of pieces) {
    while (at < nameWords.length && !nameWords[at]!.startsWith(piece)) at++;
    if (at === nameWords.length) return false;
    at++;
  }
  return true;
}

/** 쉼표로 이은 목록을 쪼개요. 비었으면 undefined. */
function list(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((v) => v.trim()).filter((v) => v !== '');
  return items && items.length > 0 ? items : undefined;
}

export function search(
  store: GraphStore,
  opts: { query?: string; kind?: string; language?: string; folder?: string; limit: number },
): SearchBody {
  const query = opts.query?.trim() || undefined;
  const kinds = list(opts.kind);
  for (const k of kinds ?? []) {
    if (!KINDS.includes(k as SymbolKind)) throw new UserError(`search: 모르는 종류예요: ${k}. 쓸 수 있는 종류: ${KINDS.join(', ')}`);
  }
  const languages = list(opts.language)?.map((l) => l.toLowerCase());
  // 폴더는 '/'로 적어요. Windows에서 '\'로 줘도, 앞의 './'나 끝의 '/'가 있어도 같게 봐요.
  const folder = opts.folder?.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '') || undefined;
  const filter: SearchFilter = {
    ...(kinds ? { kinds: kinds as SymbolKind[] } : {}),
    ...(languages ? { languages } : {}),
    ...(folder ? { folder } : {}),
  };
  const counts = store.useCounts();
  const found: SearchItem[] = store
    .searchCandidates(filter)
    .filter((row) => query === undefined || matches(query, row))
    .map((row) => ({ ...row, uses: counts.get(row.key) ?? 0 }));
  // 후보는 경로·줄·열 순으로 오고 정렬은 안정적이라, 사용처 수가 같으면 그 순서가 남아요.
  found.sort((a, b) => b.uses - a.uses);
  return {
    query: query ?? null,
    filters: {
      ...(kinds ? { kind: kinds as SymbolKind[] } : {}),
      ...(languages ? { language: languages } : {}),
      ...(folder ? { folder } : {}),
    },
    results: page(found.slice(0, opts.limit), found.length),
  };
}

export const searchQuery: QueryDef = {
  name: 'search',
  description:
    '정확한 이름을 몰라 context로 바로 물을 수 없을 때 시작점을 찾아요. 이름 일부(대소문자 무시, 예: cart → GiftCart)나 ' +
    '낙타 표기 조각(예: cartProv, CP → cartProvider)으로 심볼을 찾고, 종류(kind)·언어(language)·폴더(folder)로 좁혀요. ' +
    '결과마다 정의 위치와 사용처 수(uses)가 있고 많이 쓰이는 것이 먼저 와요. 결과의 key를 그대로 context에 넘기면 그 심볼 하나의 사용처를 볼 수 있어요. ' +
    '의미(임베딩) 검색은 하지 않아요.',
  params: [
    {
      name: 'query',
      type: 'string',
      positional: true,
      description:
        '찾을 이름 일부나 낙타 표기 조각. 점(.)을 넣으면 바깥 타입을 붙인 이름에서 찾아요(Cart.ad). 빼면 조건(kind, language, folder)에 맞는 심볼 전부예요.',
    },
    {
      name: 'kind',
      type: 'string',
      description: `심볼 종류로 좁혀요. 쉼표로 여럿(function,method). 쓸 수 있는 것: ${KINDS.join(', ')}.`,
    },
    { name: 'language', type: 'string', description: '정의된 파일의 언어로 좁혀요(예: dart). 쉼표로 여럿.' },
    { name: 'folder', type: 'string', description: '저장소 기준 폴더로 좁혀요(예: lib/src). 그 아래 파일 전부가 들어가요.' },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '결과를 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) =>
    search(store, {
      query: args.query as string | undefined,
      kind: args.kind as string | undefined,
      language: args.language as string | undefined,
      folder: args.folder as string | undefined,
      limit: args.limit as number,
    }),
};
