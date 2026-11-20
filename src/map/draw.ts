// `map` 명령: 색인이 없거나 낡았으면 먼저 색인하고, 그래프에서 코드 지도 자료를 뽑아 HTML 한 장으로 그려요.
// 화면은 같은 폴더의 template.html이고, 자료는 그 안의 code-map-data 자리에 JSON으로 들어가요.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStale } from '../freshness.ts';
import { GraphStore } from '../graph/store.ts';
import { indexRepo } from '../indexer.ts';
import { defaultDb } from '../locate.ts';
import { codeMapData, type MapData } from './data.ts';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));

/** 자료를 화면 틀에 넣어 HTML 글을 만들어요. `</script>`로 틀을 깨지 않게 '<'를 바꿔 적어요. */
export function renderCodeMap(data: MapData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return readFileSync(TEMPLATE, 'utf8').replace('/*DATA*/', () => json);
}

export interface DrawOptions {
  repo: string;
  db?: string;
  config?: string;
  /** 나올 HTML 파일. 없으면 색인 파일 옆(`<색인 파일 이름>-map.html`)이에요. 저장소 안에는 쓰지 않아요. */
  out?: string;
}

/** `map` 명령의 출력. */
export interface DrawSummary {
  out: string;
  /** 그리기 전에 색인했는지(색인이 없거나 낡았을 때). */
  indexed: boolean;
  branch: string | null;
  commit: string | null;
  files: number;
  modules: number;
  backwardImports: number;
  cycles: number;
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
    const data = codeMapData(store!, opts.config);
    const out = resolve(opts.out ?? db.replace(/\.db$/, '') + '-map.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderCodeMap(data));
    return {
      out,
      indexed,
      branch: data.branch,
      commit: data.commit,
      files: data.files.length,
      modules: data.modules.length,
      backwardImports: data.back.length,
      cycles: data.cycles.length,
    };
  } finally {
    store!.close();
  }
}
