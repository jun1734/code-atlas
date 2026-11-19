// 답의 계약(docs/contract.md)을 한곳에서 지켜요. 모든 질의의 답은 이 봉투를 거쳐 나가요.
//
// - 봉투(index): 어느 저장소의 어느 커밋을 색인한 답인지, 그 뒤로 바뀐 것이 있는지. 질의는 직접 넣지 않아요.
//   질의 실행기(src/queries.ts의 askQuery)가 모든 답에 붙여요.
// - 목록(Page): 길어질 수 있는 목록은 page()로 만들어 전체 개수와 잘렸는지를 함께 내요.
// - 항목(Sourced): 목록의 항목과 답의 심볼에는 confidence(정밀/추정)와 source(낸 색인기)가 있어요.
import type { Confidence } from './facts.ts';
import { isStale } from './freshness.ts';
import type { GraphStore } from './graph/store.ts';

/** 목록을 자를 때 따로 정하지 않으면 쓰는 개수. */
export const DEFAULT_LIMIT = 100;

/** 모든 답의 `index`. */
export interface IndexInfo {
  /** 색인한 저장소의 절대 경로. */
  repo: string;
  /** 색인 기준 커밋. git 저장소가 아니면 null. */
  commit: string | null;
  /** 색인한 때(ISO 8601). */
  indexedAt: string;
  /** 색인 뒤에 커밋이 바뀌었거나 작업 트리에 바뀐 파일이 있으면 true, 그대로면 false, 알 수 없으면 null. */
  stale: boolean | null;
}

/** 답의 항목이 지는 표시: 얼마나 믿을 수 있는지와 어느 색인기가 냈는지. */
export interface Sourced {
  confidence: Confidence;
  source: string;
}

/** 길어질 수 있는 목록. items는 앞에서부터 limit개, total은 자르기 전 전체 개수. */
export interface Page<T extends Sourced> {
  total: number;
  truncated: boolean;
  items: T[];
}

/** 질의가 돌려주는 답의 몸통. `index`는 봉투 몫이라 몸통에 넣을 수 없어요. */
export type Body = { [key: string]: unknown; index?: never };

/** 봉투를 씌운 답. 바깥(명령줄, MCP)에 나가는 모양이에요. */
export type Answer<B extends Body = Body> = { index: IndexInfo } & B;

/**
 * 잘린 목록을 계약의 모양으로 만들어요.
 * @param items 앞에서부터 limit개까지 가져온 항목
 * @param total 자르기 전 전체 개수
 */
export function page<T extends Sourced>(items: T[], total: number): Page<T> {
  return { total, truncated: items.length < total, items };
}

/** 색인 파일의 기록과 지금 저장소 상태로 봉투를 만들어요. */
export function indexInfo(store: GraphStore): IndexInfo {
  const meta = store.meta();
  return { repo: meta.repoRoot, commit: meta.commit, indexedAt: meta.indexedAt, stale: isStale(meta) };
}

/** 몸통에 봉투를 씌워요. `index`가 맨 앞에 와요. */
export function envelope<B extends Body>(store: GraphStore, body: B): Answer<B> {
  return { index: indexInfo(store), ...body };
}

/** 답을 바깥에 내는 글 모양. 명령줄과 MCP가 같은 글을 내요. */
export function formatAnswer(answer: Answer): string {
  return JSON.stringify(answer, null, 2);
}
