// 질의 목록과 실행기. 명령줄(src/cli.ts)과 MCP 서버(src/mcp.ts)는 이 목록을 똑같이 감싸요.
// 새 질의는 src/query/<이름>.ts에 QueryDef 하나를 만들어 QUERIES에 한 줄 더하면 양쪽에 붙어요.
// 붙이는 법은 docs/contract.md에 있어요.
import { type Answer, type Body, envelope } from './answer.ts';
import type { GraphStore } from './graph/store.ts';
import { openIndex, type Target, UserError } from './locate.ts';
import { checkQuery } from './query/check.ts';
import { contextQuery } from './query/context.ts';
import { impactQuery } from './query/impact.ts';
import { searchQuery } from './query/search.ts';

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
}

/** 검사를 거친 인자. 없는 선택 인자는 기본값이 들어가요(기본값도 없으면 undefined). */
export type Args = Record<string, string | number | undefined>;

export interface QueryDef {
  /** 명령줄 명령 이름이자 MCP 도구 이름. */
  name: string;
  /** MCP 도구 설명. 에이전트가 언제 부를지 알 수 있게 써요. */
  description: string;
  params: Param[];
  /** 그래프에 물어 답의 몸통을 만들어요. 봉투(index)는 실행기가 씌워요. */
  run(store: GraphStore, args: Args): Body;
}

/** 명령줄과 MCP에 붙는 질의 전부. */
export const QUERIES: QueryDef[] = [contextQuery, checkQuery, impactQuery, searchQuery];

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
      args[p.name] = String(value);
    }
  }
  return args;
}

/** 저장소의 색인을 열어 질의를 돌리고, 봉투를 씌운 답을 돌려줘요. */
export function askQuery(def: QueryDef, raw: Record<string, unknown>, target: Target): Answer {
  const args = checkArgs(def, raw);
  const store = openIndex(target);
  try {
    return envelope(store, def.run(store, args));
  } finally {
    store.close();
  }
}
