// `map` 명령: 색인이 없거나 낡았으면 먼저 색인하고, 그래프에서 코드 지도 자료를 뽑아 HTML 한 장으로 그려요.
// 화면은 같은 폴더의 template.html이고, 자료는 그 안의 code-map-data 자리에 JSON으로 들어가요.
// 같은 자리에 이름 단위 그래프 화면(graph.html, 자료는 symbol-graph-data)도 그려요. 코드 지도의 파일에서 이어져요.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStale } from '../freshness.ts';
import { GraphStore } from '../graph/store.ts';
import { indexRepo } from '../indexer.ts';
import { defaultDb } from '../locate.ts';
import { matches, words } from '../query/search.ts';
import { codeMapData, type MapData } from './data.ts';
import { type GraphData, symbolGraphData } from './graph-data.ts';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));
const GRAPH_TEMPLATE = fileURLToPath(new URL('./graph.html', import.meta.url));

/** 자료를 <script> 안에 넣을 JSON 글로. `</script>`로 틀을 깨지 않게 '<'를 바꿔 적어요. */
const scriptJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

/** 자료를 화면 틀에 넣어 HTML 글을 만들어요. */
export function renderCodeMap(data: MapData): string {
  return readFileSync(TEMPLATE, 'utf8').replace('/*DATA*/', () => scriptJson(data));
}

/**
 * 그래프 화면 HTML. 화면의 검색은 search 질의의 맞춤 규칙(words, matches)의 소스를 그대로 넣어 써요.
 * 같은 규칙을 화면 쪽에 따로 짜지 않아서 명령줄 search와 어긋나지 않아요.
 */
export function renderSymbolGraph(data: GraphData): string {
  const match = `${words.toString()}\n${matches.toString()}`;
  return readFileSync(GRAPH_TEMPLATE, 'utf8')
    .replace('/*DATA*/', () => scriptJson(data))
    .replace('/*MATCH*/', () => match);
}

export interface DrawOptions {
  repo: string;
  db?: string;
  config?: string;
  /**
   * 나올 HTML 파일. 없으면 색인 파일 옆(`<색인 파일 이름>-map.html`)이에요. 저장소 안에는 쓰지 않아요.
   * 이름 단위 그래프 화면은 그 옆 `<이름>-graph.html`이에요.
   */
  out?: string;
}

/** `map` 명령의 출력. */
export interface DrawSummary {
  out: string;
  /** 이름 단위 그래프 화면(코드 지도의 파일에서 이어져요). */
  graph: string;
  /** 그리기 전에 색인했는지(색인이 없거나 낡았을 때). */
  indexed: boolean;
  branch: string | null;
  commit: string | null;
  files: number;
  modules: number;
  backwardImports: number;
  cycles: number;
  /** 그래프 화면에 담은 노드(이름과 파일) 수. */
  nodes: number;
}

export async function drawCodeMap(opts: DrawOptions): Promise<DrawSummary> {
  const repo = resolve(opts.repo);
  const db = resolve(opts.db ?? defaultDb(repo));
  let store = GraphStore.openExisting(db);
  // 색인이 낡았으면 지도가 지금 코드와 어긋나요. 색인은 바뀐 파일만 그래프에 반영해서 다시 해도 그래프 쪽은 빨라요.
  const indexed = store === null || isStale(store.meta()) === true;
  if (indexed) {
    store?.close();
    process.stderr.write(`색인이 ${store ? '낡아서 다시' : '없어서 먼저'} 색인해요: ${repo}\n`);
    await indexRepo(repo, db);
    store = GraphStore.openExisting(db)!;
  }
  try {
    const out = resolve(opts.out ?? db.replace(/\.db$/, '') + '-map.html');
    const graph = out.replace(/\.html?$/i, '') + '-graph.html';
    const data: MapData = { ...codeMapData(store!, opts.config), graph: basename(graph) };
    const graphData = symbolGraphData(store!, {
      head: data.head,
      commit: data.commit,
      branch: data.branch,
      date: data.date,
      map: basename(out),
      config: opts.config,
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderCodeMap(data));
    writeFileSync(graph, renderSymbolGraph(graphData));
    return {
      out,
      graph,
      indexed,
      branch: data.branch,
      commit: data.commit,
      files: data.files.length,
      modules: data.modules.length,
      backwardImports: data.back.length,
      cycles: data.cycles.length,
      nodes: graphData.nodes.length,
    };
  } finally {
    store!.close();
  }
}
