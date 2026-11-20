// 질의 목록과 실행기. 명령줄(src/cli.ts)과 MCP 서버(src/mcp.ts)는 이 목록을 똑같이 감싸요.
// 새 질의는 src/query/<이름>.ts에 QueryDef 하나를 만들어 QUERIES에 한 줄 더하면 양쪽에 붙어요.
// 붙이는 법은 docs/contract.md에 있어요.
import { type Answer, type Body, envelope, type IndexInfo } from './answer.ts';
import type { GraphStore } from './graph/store.ts';
import { dbOf, openIndex, type Target, UserError } from './locate.ts';
import { checkQuery } from './query/check.ts';
import { clustersQuery } from './query/clusters.ts';
import { contextQuery } from './query/context.ts';
import { detectChangesQuery } from './query/detect-changes.ts';
import { flowsQuery } from './query/flows.ts';
import { impactQuery } from './query/impact.ts';
import { renameQuery } from './query/rename.ts';
import { searchQuery } from './query/search.ts';
import { traceQuery } from './query/trace.ts';

/** 질의가 받는 인자 하나. 명령줄 옵션과 MCP 입력 스키마가 여기서 만들어져요. */
export interface Param {
  name: string;
  type: 'string' | 'integer';
  /** 명령줄 도움말과 MCP 도구 설명에 같이 나가요. */
  description: string;
  /** 명령줄에서 위치 인자로 받아요(질의마다 하나까지). MCP에서는 이름 있는 인자예요. */
  positional?: boolean;
  required?: boolean;
  default?: string | number;
  /** integer일 때 가장 작은 값. */
  min?: number;
  /** string일 때 받을 수 있는 값(이 밖의 값은 오류). MCP 입력 스키마에서는 enum이 돼요. */
  choices?: readonly string[];
}

/** 검사를 거친 인자. 없는 선택 인자는 기본값이 들어가요(기본값도 없으면 undefined). */
export type Args = Record<string, string | number | undefined>;

export interface QueryDef {
  /** 명령줄 명령 이름이자 MCP 도구 이름. */
  name: string;
  /** MCP 도구 설명. 에이전트가 언제 부를지 알 수 있게 써요. */
  description: string;
  params: Param[];
  /**
   * 그래프에 물어 답의 몸통을 만들어요. 봉투(index)는 실행기가 씌워요.
   * 색인을 새로 만들어야 하는 질의(detect_changes)는 Promise를 돌려줘도 돼요.
   */
  run(store: GraphStore, args: Args, ctx: QueryContext): Body | Promise<Body>;
}

/** 질의가 store 말고 더 알아야 할 것. */
export interface QueryContext {
  /** 물은 저장소의 색인 파일(절대 경로). 색인을 다시 하거나 그 옆에 다른 색인을 둘 때 써요. */
  db: string;
  /**
   * 답을 저장소 색인이 아닌 다른 색인(커밋 색인)에서 만들었거나 다른 색인과 견줬으면, 봉투에 쓸 그 색인의 정보를 알려요.
   * 부르지 않으면 봉투는 저장소 색인의 것이에요. 질의는 몸통에 index를 넣지 못하니 이것으로만 봉투를 정해요.
   */
  describeIndex(info: IndexInfo): void;
}

/** 명령줄과 MCP에 붙는 질의 전부. */
export const QUERIES: QueryDef[] = [contextQuery, checkQuery, impactQuery, detectChangesQuery, searchQuery, traceQuery, clustersQuery, renameQuery, flowsQuery];

/** 바깥에서 받은 인자(명령줄은 글, MCP는 JSON 값)를 질의의 Param대로 검사해요. */
export function checkArgs(def: QueryDef, raw: Record<string, unknown>): Args {
  const args: Args = {};
  for (const p of def.params) {
    const value = raw[p.name];
    if (value === undefined || value === null) {
      if (p.required) throw new UserError(`${def.name}: ${p.name}이(가) 필요해요.`);
      args[p.name] = p.default;
      continue;
    }
    if (p.type === 'integer') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || (p.min !== undefined && n < p.min)) {
        const want = p.min === undefined ? '정수' : `${p.min} 이상의 정수`;
        throw new UserError(`${def.name}: ${p.name}은(는) ${want}여야 해요: ${String(value)}`);
      }
      args[p.name] = n;
    } else {
      const s = String(value);
      if (p.choices && !p.choices.includes(s)) {
        throw new UserError(`${def.name}: ${p.name}는 ${p.choices.join(' 또는 ')} 중 하나여야 해요: ${s}`);
      }
      args[p.name] = s;
    }
  }
  return args;
}

/**
 * 저장소의 색인을 열어 질의를 돌리고, 봉투를 씌운 답을 돌려줘요. 봉투는 질의가 끝난 뒤의 색인 상태예요.
 * 질의가 다른 색인으로 답했다고 알렸으면(ctx.describeIndex) 그것이 봉투예요.
 */
export async function askQuery(def: QueryDef, raw: Record<string, unknown>, target: Target): Promise<Answer> {
  const args = checkArgs(def, raw);
  const store = openIndex(target);
  try {
    let described = null as IndexInfo | null;
    const body = await def.run(store, args, { db: dbOf(target), describeIndex: (info) => (described = info) });
    return envelope(store, body, described ?? undefined);
  } finally {
    store.close();
  }
}
