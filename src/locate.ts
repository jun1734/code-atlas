// 저장소마다 색인 파일 자리를 정하고 열어요. 명령줄과 MCP 서버가 같이 써요.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore } from './graph/store.ts';

/** 질문할 저장소. db를 주면 그 색인 파일을, 아니면 저장소의 기본 자리를 써요. */
export interface Target {
  repo: string;
  db?: string;
}

/** 바깥(명령줄, MCP)에 그대로 보여 줄 오류. 고칠 방법을 메시지에 담아요. */
export class UserError extends Error {}

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** 저장소 경로마다 저장소 밖에 색인 파일 자리를 하나씩 정해요. */
export function defaultDb(repo: string): string {
  const abs = resolve(repo);
  // Windows 경로는 대소문자를 가리지 않아서 소문자로 맞춰요.
  const id = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
  const home = process.env.CODE_ATLAS_HOME ?? join(homedir(), '.code-atlas');
  return join(home, `${basename(abs)}-${hash}.db`);
}

/** 저장소의 색인을 열어요. 없으면 색인하는 명령을 담은 UserError를 던져요. */
export function openIndex(target: Target): GraphStore {
  const repo = resolve(target.repo);
  const db = target.db ?? defaultDb(repo);
  const store = GraphStore.openExisting(db);
  if (store) return store;
  const dbArg = target.db ? ` --db "${resolve(target.db)}"` : '';
  throw new UserError(
    `색인이 없어요: ${repo}\n(찾은 자리: ${db})\n먼저 색인해요: node "${CLI}" index "${repo}"${dbArg}`,
  );
}
