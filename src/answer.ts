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
  /** 색인 뒤에 커밋이 바뀌었거나 작업 트리가 색인할 때와 달라졌으면 true, 그대로면 false, 알 수 없으면 null. */
  stale: boolean | null;
  /**
   * 답이 다른 커밋의 색인과 견준 것이면(detect_changes의 바꾸기 전) 그 커밋과 그 색인을 만든 때.
   * 바뀐 것이 없어 그 색인을 쓰지 않았으면 indexedAt은 null. 커밋 색인은 낡지 않아요.
   */
  base?: { commit: string; indexedAt: string | null };
}

/** 답의 항목이 지는 표시: 얼마나 믿을 수 있는지와 어느 색인기가 냈는지. */
export interface Sourced {
  confidence: Confidence;
  source: string;
}

/** 길어질 수 있는 목록. items는 앞에서부터 limit개, total은 자르기 전 전체 개수. */
export interface List<T> {
  total: number;
  truncated: boolean;
  items: T[];
}

/** 답의 항목 목록. 항목마다 정밀/추정과 출처(Sourced)가 있어야 해요. */
export type Page<T extends Sourced> = List<T>;

/**
 * 항목 안쪽의 목록(서로 물린 파일 묶음의 파일, 묶음의 이름 등). 바깥 목록과 같은 limit으로 잘려요.
 * 항목이 글(경로, 이름)이라, 그 표시(confidence, source)는 이 목록을 가진 바깥 항목의 것이에요.
 */
export type InnerList<T> = List<T>;

/** 질의가 돌려주는 답의 몸통. `index`는 봉투 몫이라 몸통에 넣을 수 없어요. */
export type Body = { [key: string]: unknown; index?: never };

/** 봉투를 씌운 답. 바깥(명령줄, MCP)에 나가는 모양이에요. */
export type Answer<B extends Body = Body> = { index: IndexInfo } & B;

/**
 * 잘린 목록을 계약의 모양으로 만들어요.
 * @param items 앞에서부터 limit개까지 가져온 항목
 * @param total 자르기 전 전체 개수
 */
export function page<T>(items: T[], total: number): List<T> {
  return { total, truncated: items.length < total, items };
}

/** 목록 전체를 앞에서부터 limit개로 잘라 계약의 모양(Page, InnerList)으로. */
export function cut<T>(all: T[], limit: number): List<T> {
  return page(all.slice(0, limit), all.length);
}

/** 여럿 가운데 가장 낮은 믿음: 하나라도 추정(inferred)이면 inferred, 비었거나 모두 정밀이면 precise. */
export function lowest(confidences: Iterable<Confidence>): Confidence {
  for (const c of confidences) if (c === 'inferred') return 'inferred';
  return 'precise';
}

/** 여러 출처(쉼표로 이은 색인기 이름일 수 있음)를 겹치지 않게 모아 이름순으로 이어요. */
export function joinSources(sources: Iterable<string>): string {
  const all = new Set<string>();
  for (const s of sources) for (const one of s.split(',')) if (one !== '') all.add(one);
  return [...all].sort(compareText).join(',');
}

/**
 * 여러 관계·항목을 묶은 항목의 표시. 규칙은 모든 질의에서 하나예요:
 * 믿음은 가장 낮은 것(하나라도 추정이면 추정), 출처는 낸 색인기 모두.
 */
export function sourcedOf(parts: Iterable<Sourced>): Sourced {
  const list = [...parts];
  return { confidence: lowest(list.map((p) => p.confidence)), source: joinSources(list.map((p) => p.source)) };
}

/**
 * 답의 순서를 정하는 글 비교. 코드포인트(UTF-16 단위) 순이라 OS·로캘과 상관없이 같은 답이 나와요.
 * localeCompare는 로캘마다 다르게 세울 수 있어서 쓰지 않아요.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 색인 파일의 기록과 지금 저장소 상태로 봉투를 만들어요. */
export function indexInfo(store: GraphStore): IndexInfo {
  const meta = store.meta();
  return { repo: meta.repoRoot, commit: meta.commit, indexedAt: meta.indexedAt, stale: isStale(meta) };
}

/** 몸통에 봉투를 씌워요. `index`가 맨 앞에 와요. info를 주면(질의가 다른 색인으로 답했을 때) 그것이 봉투예요. */
export function envelope<B extends Body>(store: GraphStore, body: B, info?: IndexInfo): Answer<B> {
  return { index: info ?? indexInfo(store), ...body };
}

/** 답을 바깥에 내는 글 모양. 명령줄과 MCP가 같은 글을 내요. */
export function formatAnswer(answer: Answer): string {
  return JSON.stringify(answer, null, 2);
}
