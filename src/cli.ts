#!/usr/bin/env node
// 명령줄: 질의 모듈을 얇게 감싸요. 답은 JSON으로 stdout에 써요.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GraphStore } from './graph/store.ts';
import { indexRepo } from './indexer.ts';
import { context } from './query/context.ts';

const USAGE = `사용법:
  code-atlas index [저장소=.] [--db 파일]
  code-atlas context <이름|qualifiedName|key> [--repo 저장소=.] [--db 파일] [--limit 100]

--db를 주지 않으면 색인은 ~/.code-atlas/<저장소이름>-<경로해시>.db 에 둬요(CODE_ATLAS_HOME으로 폴더를 바꿔요).`;

/** 저장소 경로마다 저장소 밖에 색인 파일 자리를 하나씩 정해요. */
function defaultDb(repo: string): string {
  const abs = resolve(repo);
  // Windows 경로는 대소문자를 가리지 않아서 소문자로 맞춰요.
  const id = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
  const home = process.env.CODE_ATLAS_HOME ?? join(homedir(), '.code-atlas');
  return join(home, `${basename(abs)}-${hash}.db`);
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    process.stderr.write(USAGE + '\n');
    return command ? 0 : 2;
  }

  if (command === 'index') {
    const repo = arg ?? '.';
    print(await indexRepo(repo, values.db ?? defaultDb(repo)));
    return 0;
  }

  if (command === 'context') {
    if (!arg) {
      process.stderr.write(USAGE + '\n');
      return 2;
    }
    const db = values.db ?? defaultDb(values.repo ?? '.');
    const store = GraphStore.openExisting(db);
    if (!store) {
      process.stderr.write(`색인이 없어요: ${db}\n먼저 code-atlas index 를 돌려요.\n`);
      return 1;
    }
    try {
      const limit = values.limit === undefined ? 100 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit은 1 이상의 정수여야 해요: ${values.limit}`);
      print(context(store, arg, limit));
    } finally {
      store.close();
    }
    return 0;
  }

  process.stderr.write(`모르는 명령이에요: ${command}\n${USAGE}\n`);
  return 2;
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
