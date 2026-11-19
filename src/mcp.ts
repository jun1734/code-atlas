// MCP 서버: 질의 목록(src/queries.ts)을 공식 MCP SDK 도구로 감싸요. 논리는 없어요.
// stdio로만 말해요(네트워크 포트를 열지 않아요). stdout은 프로토콜 몫이라 다른 글을 쓰지 않아요.
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatAnswer } from './answer.ts';
import { askQuery, type Param, QUERIES, type QueryDef } from './queries.ts';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Param 하나를 MCP 입력 스키마(zod)로. */
function schemaOf(p: Param): z.ZodType {
  let s: z.ZodType = p.type === 'integer' ? z.number().int().min(p.min ?? Number.MIN_SAFE_INTEGER) : z.string();
  const extra = p.default === undefined ? '' : ` (기본 ${p.default})`;
  s = s.describe(p.description + extra);
  return p.required ? s : s.optional();
}

function register(server: McpServer, def: QueryDef, defaultRepo: string): void {
  const shape: Record<string, z.ZodType> = {
    repo: z
      .string()
      .optional()
      .describe(`물을 저장소의 경로. 저장소마다 따로 색인해요. 없으면 서버를 띄운 저장소(${defaultRepo}).`),
  };
  for (const p of def.params) shape[p.name] = schemaOf(p);
  server.registerTool(def.name, { description: def.description, inputSchema: shape }, async (input) => {
    const { repo, ...raw } = input as Record<string, unknown>;
    try {
      const answer = askQuery(def, raw, { repo: typeof repo === 'string' ? repo : defaultRepo });
      return { content: [{ type: 'text', text: formatAnswer(answer) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
    }
  });
}

/** stdio MCP 서버를 열어요. defaultRepo: 도구 호출에 repo가 없을 때 물을 저장소. */
export async function serveMcp(defaultRepo: string): Promise<void> {
  const server = new McpServer({ name: 'code-atlas', version });
  for (const def of QUERIES) register(server, def, defaultRepo);
  await server.connect(new StdioServerTransport());
}
