// 영향 범위(impact): 여러 단계로 서로 쓰는 예제 저장소를 실제 scip-dart로 색인하고, 명령줄과 MCP의 impact 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, startMcp, type IndexedFixture, type McpSession } from './harness.ts';

/** 거리별로 묶은 영향 받는 곳의 이름(같은 거리 안은 답의 순서 그대로). */
function namesByDistance(answer: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of answer.affected.items) (out[item.distance] ??= []).push(`${item.path}#${item.name}`);
  return out;
}

describe('impact_sample impact', () => {
  let home: string;
  let fx: IndexedFixture;
  let mcp: McpSession;
  let answer: any;
  const want = expected('impact_sample', 'impact-withVat.json');
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('impact_sample', { home });
    answer = fx.ask('impact', 'withVat');
    mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
  });
  after(async () => {
    await mcp?.close();
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('이름을 주면 직접 쓰는 곳에서 시작해 그것을 쓰는 곳으로 거슬러 올라가며 거리별로 나온다', () => {
    assert.equal(answer.status, 'found');
    assert.deepEqual(answer.target, want.target);
    assert.deepEqual(answer.affected, want.affected);
    assert.deepEqual(answer.summary.byDistance, { 1: 1, 2: 2, 3: 2 });
  });

  it('파일을 주면 그 파일과 그 파일이 정의한 이름을 쓰는 곳이 거리별로 나온다(가져다 쓰는 파일 포함)', () => {
    const byFile = fx.ask('impact', 'lib/core/money.dart', '--depth', '1');
    assert.equal(byFile.status, 'found');
    assert.deepEqual(byFile.target, { path: 'lib/core/money.dart', language: 'dart', role: 'app', names: 2, hotNames: ['won'] });
    assert.deepEqual(namesByDistance(byFile), {
      1: [
        'lib/features/cart/cart.dart#lib/features/cart/cart.dart',
        'lib/features/cart/cart.dart#Cart.total',
        'lib/features/checkout/checkout.dart#lib/features/checkout/checkout.dart',
        'lib/features/checkout/checkout.dart#checkoutLine',
        'lib/features/receipt/receipt.dart#lib/features/receipt/receipt.dart',
        'lib/features/receipt/receipt.dart#receiptRows',
      ],
    });
    const imported = byFile.affected.items.find((i: any) => i.name === 'lib/features/cart/cart.dart');
    assert.equal(imported.kind, 'file');
    assert.equal(imported.via.relation, 'import');
  });

  it('영향 받는 곳이 모듈별로 묶여 나온다', () => {
    assert.deepEqual(answer.modules, want.modules);
    assert.deepEqual(
      answer.affected.items.map((i: any) => [i.name, i.module]),
      [['Cart.total', 'cart'], ['checkoutLine', 'checkout'], ['main', null], ['runApp', 'app'], ['main', null]],
    );
    assert.equal(answer.config, '.code-atlas.json');
  });

  it('영향 범위에 걸린 테스트 파일 목록이 따로 나온다', () => {
    assert.deepEqual(answer.tests, want.tests);
    assert.equal(answer.summary.tests, 2);
  });

  it('탐색 깊이를 줄이면 그 거리까지만 나오고, 더 있다는 표시가 붙는다', () => {
    const shallow = fx.ask('impact', 'withVat', '--depth', '2');
    assert.deepEqual(namesByDistance(shallow), {
      1: ['lib/features/cart/cart.dart#Cart.total'],
      2: ['lib/features/checkout/checkout.dart#checkoutLine', 'test/cart_test.dart#main'],
    });
    assert.equal(shallow.summary.moreBeyondDepth, true);
    assert.deepEqual(shallow.tests.items.map((t: any) => t.path), ['test/cart_test.dart']);
    assert.equal(answer.summary.moreBeyondDepth, false);
  });

  it('결과 개수를 제한하면 잘리고, 잘린 사실과 전체 개수가 나온다', () => {
    const cut = fx.ask('impact', 'withVat', '--limit', '2');
    assert.deepEqual([cut.affected.total, cut.affected.truncated, cut.affected.items.length], [5, true, 2]);
    assert.deepEqual(cut.affected.items, want.affected.items.slice(0, 2));
    assert.deepEqual([cut.tests.total, cut.tests.truncated, cut.tests.items.length], [2, false, 2]);
    const one = fx.ask('impact', 'withVat', '--limit', '1');
    assert.deepEqual([one.tests.total, one.tests.truncated, one.tests.items.length], [2, true, 1]);
  });

  it(`많이 쓰이는 이름(사용처 20개 이상)에는 hot 표시가 붙는다`, () => {
    const won = fx.ask('impact', 'won', '--depth', '1');
    assert.deepEqual([won.target.uses, won.target.hot, won.summary.hotUses], [20, true, 20]);
    assert.equal(answer.target.hot, false);
    // 기준을 낮추면 사용처 2개인 Cart.total과 checkoutLine도 hot이 된다
    const low = fx.ask('impact', 'withVat', '--hot', '2');
    assert.deepEqual(
      low.affected.items.filter((i: any) => i.hot).map((i: any) => i.name),
      ['Cart.total', 'checkoutLine'],
    );
  });

  it('항목마다 정밀/추정과 출처가 붙는다(정밀 색인기만 거친 이 예제는 모두 precise)', () => {
    for (const item of [...answer.affected.items, ...answer.tests.items]) {
      assert.equal(item.confidence, 'precise', JSON.stringify(item));
      assert.equal(item.source, 'scip-dart');
    }
  });

  it('이름이 없으면 not_found, 여럿이면 고르지 않고 후보를 돌려준다', () => {
    assert.deepEqual(fx.ask('impact', 'noSuchName'), { index: fx.ask('impact', 'noSuchName').index, query: 'noSuchName', status: 'not_found' });
    const many = fx.ask('impact', 'main');
    assert.equal(many.status, 'ambiguous');
    assert.deepEqual(many.candidates.map((c: any) => c.definition.path), ['test/cart_test.dart', 'test/checkout_test.dart']);
  });

  it('MCP 도구로도 같은 답이 나온다', async () => {
    assert.ok((await mcp.tools()).includes('impact'));
    assert.deepEqual(await mcp.call('impact', { target: 'withVat' }), answer);
    assert.deepEqual(await mcp.call('impact', { target: 'withVat', depth: 2, limit: 1 }), fx.ask('impact', 'withVat', '--depth', '2', '--limit', '1'));
  });
});
