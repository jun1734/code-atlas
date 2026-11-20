// 답의 계약(docs/contract.md)을 도구 호출 경계에서 봐요: 명령줄과 MCP 서버를 실제 프로세스로 불러요.
// 두 저장소를 한 색인 폴더에 색인해 두고, MCP 서버는 첫 저장소에서 띄워요.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  indexFixture,
  NETWORK_EXIT,
  NO_NETWORK,
  runCliRaw,
  startMcp,
  unmarked,
  type IndexedFixture,
  type McpSession,
} from './harness.ts';

/** 계약이 모든 답에 요구하는 것: 색인 기준 커밋과 낡음 표시. */
function assertIndex(answer: any, fx: IndexedFixture, stale: boolean): void {
  assert.equal(answer.index.repo, fx.repo);
  assert.equal(answer.index.commit, fx.head());
  assert.equal(typeof answer.index.indexedAt, 'string');
  assert.equal(answer.index.stale, stale);
}

/** 계약의 항목 규칙(docs/contract.md 약속 3)을 보는 질문. 모든 질의와 파일·심볼 지점을 고루 넣어요. */
const ITEM_QUESTIONS: string[][] = [
  ['context', 'withTax'],
  ['context', 'add'],
  ['context', 'Cart'],
  ['context', 'lib/src/pricing.dart'],
  ['impact', 'withTax'],
  ['impact', 'lib/src/pricing.dart'],
  ['impact', 'add'],
  ['check'],
  ['trace', 'Cart.total', '--to', 'withTax'],
  ['trace', 'lib/src/cart.dart', '--to', 'lib/src/pricing.dart', '--follow', 'all'],
  ['trace', 'main', '--to', 'withTax'],
  ['search', 'cart'],
  ['clusters'],
  ['flows'],
  ['flows', 'withTax'],
  ['detect_changes'],
  ['rename', 'Cart', '--to', 'Basket'],
  ['rename', 'Cart.total', '--to', 'add'],
  ['rename', 'add', '--to', 'push'],
];

describe('답의 계약 (명령줄과 MCP)', () => {
  let home: string;
  let first: IndexedFixture;
  let second: IndexedFixture;
  let mcp: McpSession;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    first = indexFixture('dart_sample', { home });
    second = indexFixture('dart_sample', {
      home,
      extraFiles: { 'lib/src/extra.dart': 'int onlyInSecond() => 1;\n' },
    });
    mcp = await startMcp({ cwd: first.repo, env: { CODE_ATLAS_HOME: home } });
  });
  after(async () => {
    await mcp?.close();
    first?.dispose();
    second?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('공식 MCP SDK로 연 서버에 context 도구가 있다', async () => {
    assert.ok((await mcp.tools()).includes('context'));
  });

  it('MCP의 context는 명령줄과 같은 답을 돌려준다', async () => {
    for (const query of ['withTax', 'add', 'Wishlist.add', 'noSuchName']) {
      assert.deepEqual(await mcp.call('context', { query }), first.ask('context', query), query);
    }
    assert.deepEqual(
      await mcp.call('context', { query: 'withTax', limit: 1 }),
      first.ask('context', 'withTax', '--limit', '1'),
    );
  });

  it('모든 답에 색인 기준 커밋과 색인 뒤 바뀐 파일이 있는지가 들어간다', async () => {
    for (const query of ['withTax', 'add', 'noSuchName']) {
      assertIndex(first.ask('context', query), first, false);
      assertIndex(await mcp.call('context', { query }), first, false);
    }
    first.append('lib/src/pricing.dart', '\n// 바뀜\n');
    try {
      assertIndex(first.ask('context', 'withTax'), first, true);
      assertIndex(await mcp.call('context', { query: 'withTax' }), first, true);
    } finally {
      first.restore();
    }
  });

  it('답이 길면 잘리고, 잘린 사실과 전체 개수가 나온다', async () => {
    for (const answer of [first.ask('context', 'withTax', '--limit', '2'), await mcp.call('context', { query: 'withTax', limit: 2 })]) {
      assert.equal(answer.uses.total, 4);
      assert.equal(answer.uses.truncated, true);
      assert.equal(answer.uses.items.length, 2);
    }
    const whole = await mcp.call('context', { query: 'withTax' });
    assert.deepEqual([whole.uses.total, whole.uses.truncated, whole.uses.items.length], [4, false, 4]);
  });

  it('답의 항목마다 정밀/추정과 출처가 붙는다(모든 질의, 예외는 집계와 파일 지점뿐)', () => {
    for (const q of ITEM_QUESTIONS) {
      const answer = first.ask(...q);
      assert.deepEqual(unmarked(answer), [], `${q.join(' ')}\n${JSON.stringify(answer, null, 1).slice(0, 2000)}`);
    }
  });

  it('여러 저장소를 각각 색인해 두고 물을 때 저장소를 고른다', async () => {
    // 명령줄: --repo
    assert.equal(second.ask('context', 'onlyInSecond').status, 'found');
    assert.equal(first.ask('context', 'onlyInSecond').status, 'not_found');
    // MCP: repo 인자. 없으면 서버를 띄운 폴더(첫 저장소)
    const picked = await mcp.call('context', { query: 'onlyInSecond', repo: second.repo });
    assert.equal(picked.status, 'found');
    assertIndex(picked, second, false);
    const fallback = await mcp.call('context', { query: 'onlyInSecond' });
    assert.equal(fallback.status, 'not_found');
    assertIndex(fallback, first, false);
  });

  it('색인이 없는 저장소를 물으면 색인하는 법을 알려 준다', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'code-atlas-bare-'));
    try {
      const cli = runCliRaw(['context', 'withTax', '--repo', bare], { CODE_ATLAS_HOME: home });
      assert.equal(cli.status, 1);
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /색인이 없어요/);
      assert.ok(cli.stderr.includes(` index "${bare}"`), cli.stderr);

      const viaMcp = await mcp.callRaw('context', { query: 'withTax', repo: bare });
      assert.equal(viaMcp.isError, true);
      assert.match(viaMcp.text, /색인이 없어요/);
      assert.ok(viaMcp.text.includes(` index "${bare}"`), viaMcp.text);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('네트워크 차단 장치는 연결 시도를 잡는다(그래서 장치를 단 위 질문들은 네트워크를 쓰지 않았다)', () => {
    for (const code of ["fetch('http://127.0.0.1:9')", "require('node:net').connect(9, '127.0.0.1')", "require('node:dns').lookup('example.com', () => {})"]) {
      const r = spawnSync(process.execPath, ['--import', NO_NETWORK, '-e', code], { encoding: 'utf8' });
      assert.equal(r.status, NETWORK_EXIT, `${code}\n${r.stderr}`);
    }
  });
});
