#!/usr/bin/env node
// 명령줄: 색인(index), MCP 서버(mcp), 그리고 질의 목록(src/queries.ts)을 얇게 감싸요. 답은 JSON으로 stdout에 써요.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatAnswer } from './answer.ts';
import { indexRepo } from './indexer.ts';
import { defaultDb } from './locate.ts';
import { drawCodeMap } from './map/draw.ts';
import { serveMcp } from './mcp.ts';
import { askQuery, QUERIES, type QueryDef } from './queries.ts';

function usageOf(def: QueryDef): string {
  const pos = def.params.filter((p) => p.positional).map((p) => `<${p.name}>`);
  const opts = def.params.filter((p) => !p.positional).map((p) => `[--${p.name} ${p.default ?? p.type}]`);
  return `  code-atlas ${[def.name, ...pos, '[--repo 저장소=.] [--db 파일]', ...opts].join(' ')}`;
}

const USAGE = `사용법:
  code-atlas index [저장소=.] [--db 파일]
  code-atlas mcp [--repo 기본저장소=.]
  code-atlas map [--repo 저장소=.] [--db 파일] [--config 파일] [--out HTML파일]
${QUERIES.map(usageOf).join('\n')}

--db를 주지 않으면 색인은 ~/.code-atlas/<저장소이름>-<경로해시>.db 에 둬요(CODE_ATLAS_HOME으로 폴더를 바꿔요).
map은 코드 지도 HTML을 그려요. 색인이 없거나 낡았으면 먼저 색인해요. --out이 없으면 색인 파일 옆 <이름>-map.html이에요.`;

function print(text: string): void {
  process.stdout.write(text + '\n');
}

async function main(argv: string[]): Promise<number> {
  // 이름 있는 인자는 모두 글로 받고, 검사(정수인지 등)는 질의 실행기(checkArgs)에 맡겨요.
  const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
    db: { type: 'string' },
    repo: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    out: { type: 'string' },
  };
  for (const def of QUERIES) for (const p of def.params) if (!p.positional) options[p.name] = { type: 'string' };
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
  const [command, arg] = positionals;
  if (values.help || !command) {
    process.stderr.write(USAGE + '\n');
    return command ? 0 : 2;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  if (command === 'index') {
    const repo = arg ?? '.';
    print(JSON.stringify(await indexRepo(repo, str(values.db) ?? defaultDb(repo)), null, 2));
    return 0;
  }

  if (command === 'mcp') {
    await serveMcp(resolve(str(values.repo) ?? '.'));
    return 0;
  }

  if (command === 'map') {
    const summary = await drawCodeMap({ repo: str(values.repo) ?? '.', db: str(values.db), config: str(values.config), out: str(values.out) });
    print(JSON.stringify(summary, null, 2));
    return 0;
  }

  const def = QUERIES.find((q) => q.name === command);
  if (!def) {
    process.stderr.write(`모르는 명령이에요: ${command}\n${USAGE}\n`);
    return 2;
  }
  const raw: Record<string, unknown> = {};
  for (const p of def.params) {
    raw[p.name] = p.positional ? arg : values[p.name];
  }
  print(formatAnswer(askQuery(def, raw, { repo: str(values.repo) ?? '.', db: str(values.db) })));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
