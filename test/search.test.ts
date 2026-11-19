// 심볼 검색(search): Dart 예제 저장소를 실제 scip-dart로 색인하고, 명령줄과 MCP의 search 답을 봐요.
// 정답은 예제 저장소(test/fixtures/dart_sample)의 코드에서 손으로 센 것이에요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { indexFixture, runCliRaw, startMcp, type IndexedFixture, type McpSession } from './harness.ts';

/** 답의 항목을 "바깥 타입을 붙인 이름 @ 경로" 꼴로 줄여 비교하기 쉽게 해요(순서 그대로). */
const names = (answer: any) => answer.results.items.map((r: any) => `${r.qualifiedName} @ ${r.definition.path}`);

describe('dart_sample search', () => {
  let home: string;
  let fx: IndexedFixture;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('dart_sample', { home });
  });
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('이름 일부로 대소문자를 가리지 않고 찾고, 많이 쓰이는 것이 먼저 나온다', () => {
    // Cart와 cartProvider는 사용처가 3개씩(같으면 경로순), GiftCart는 1개예요.
    assert.deepEqual(names(fx.ask('search', 'CART')), [
      'Cart @ lib/src/cart.dart',
      'cartProvider @ lib/src/providers.dart',
      'GiftCart @ lib/src/cart.dart',
    ]);
  });

  it('낙타 표기 조각으로 찾는다(낱말 머리를 차례로 맞추고, 건너뛰어도 된다)', () => {
    assert.deepEqual(names(fx.ask('search', 'cartProv')), ['cartProvider @ lib/src/providers.dart']);
    assert.deepEqual(names(fx.ask('search', 'totProv')), ['totalProvider @ lib/src/providers.dart']);
    assert.deepEqual(names(fx.ask('search', 'GC')), ['GiftCart @ lib/src/cart.dart']);
    // 조각이 낱말 머리에 맞지 않으면 빠져요(Provider의 머리는 P예요).
    assert.deepEqual(names(fx.ask('search', 'cartRov')), []);
  });

  it('점을 넣으면 바깥 타입을 붙인 이름에서 찾는다', () => {
    assert.deepEqual(names(fx.ask('search', 'cart.AD')), ['Cart.add @ lib/src/cart.dart']);
  });

  it('종류로 좁힌다(쉼표로 여럿, 이름 없이 종류만도 된다)', () => {
    assert.deepEqual(names(fx.ask('search', '--kind', 'class')), [
      'Cart @ lib/src/cart.dart',
      'GiftCart @ lib/src/cart.dart',
      'Wishlist @ lib/src/cart.dart',
    ]);
    // abstract interface class는 interface예요.
    assert.deepEqual(names(fx.ask('search', '--kind', 'interface')), ['Totaled @ lib/src/cart.dart']);
    assert.deepEqual(names(fx.ask('search', 'total', '--kind', 'function,method')), [
      'Cart.total @ lib/src/cart.dart',
      'Totaled.total @ lib/src/cart.dart',
    ]);
    const answer = fx.ask('search', 'prices', '--kind', 'field');
    assert.deepEqual(answer.filters, { kind: ['field'] });
    assert.deepEqual(names(answer), ['Cart.prices @ lib/src/cart.dart', 'Wishlist.prices @ lib/src/cart.dart']);
  });

  it('모르는 종류를 주면 쓸 수 있는 종류를 알려 주는 오류를 낸다', () => {
    const r = runCliRaw(['search', 'cart', '--kind', 'klass', '--repo', fx.repo], { CODE_ATLAS_HOME: home });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /klass/);
    assert.match(r.stderr, /class, interface/);
  });

  it('언어로 좁힌다', () => {
    assert.deepEqual(names(fx.ask('search', 'withTax', '--language', 'Dart')), ['withTax @ lib/src/pricing.dart']);
    assert.deepEqual(fx.ask('search', 'withTax', '--language', 'typescript').results, { total: 0, truncated: false, items: [] });
  });

  it('폴더로 좁힌다(그 아래 파일 전부, 앞의 ./나 끝의 /, \\ 구분자도 받는다)', () => {
    assert.deepEqual(names(fx.ask('search', 'main')), ['main @ bin/checkout.dart', 'main @ test/pricing_test.dart']);
    assert.deepEqual(names(fx.ask('search', 'main', '--folder', 'test')), ['main @ test/pricing_test.dart']);
    assert.deepEqual(names(fx.ask('search', 'main', '--folder', './bin/')), ['main @ bin/checkout.dart']);
    assert.deepEqual(names(fx.ask('search', '--folder', 'lib\\src', '--kind', 'constant')), ['shippingFee @ lib/src/pricing.dart']);
    // 폴더 이름의 앞부분만 같은 다른 폴더(lib/src → lib/s)는 맞지 않아요.
    assert.equal(fx.ask('search', '--folder', 'lib/s').results.total, 0);
  });

  it('결과에 정의 위치, 종류, 언어, 사용처 수, 정밀/추정과 색인기가 나온다', () => {
    const [item] = fx.ask('search', 'withTax').results.items;
    const { key, ...rest } = item;
    assert.equal(typeof key, 'string');
    assert.deepEqual(rest, {
      name: 'withTax',
      qualifiedName: 'withTax',
      kind: 'function',
      definition: { path: 'lib/src/pricing.dart', line: 2, column: 5 },
      language: 'dart',
      role: 'app',
      uses: 4,
      confidence: 'precise',
      source: 'scip-dart',
    });
  });

  it('결과의 key를 그대로 context에 넘기면 그 심볼 하나를 찾고, 사용처 수가 같다', () => {
    // 'add'는 짧은 이름으로 context에 물으면 둘이라 모호해요. key로 물으면 하나씩 찾아요.
    assert.equal(fx.ask('context', 'add').status, 'ambiguous');
    const items = fx.ask('search', 'add').results.items;
    assert.deepEqual(items.map((i: any) => i.qualifiedName), ['Cart.add', 'Wishlist.add']);
    for (const item of items) {
      const ctx = fx.ask('context', item.key);
      assert.equal(ctx.status, 'found', item.key);
      assert.equal(ctx.symbol.qualifiedName, item.qualifiedName);
      assert.deepEqual(ctx.symbol.definition, item.definition);
      assert.equal(ctx.uses.total, item.uses);
    }
  });

  it('결과는 limit으로 잘리고, 답에 봉투(index)를 씌운다', () => {
    const answer = fx.ask('search', 'cart', '--limit', '1');
    assert.equal(answer.index.repo, fx.repo);
    assert.equal(answer.index.stale, false);
    assert.equal(answer.query, 'cart');
    assert.equal(answer.results.total, 3);
    assert.equal(answer.results.truncated, true);
    assert.deepEqual(names(answer), ['Cart @ lib/src/cart.dart']);
  });

  describe('MCP', () => {
    let mcp: McpSession;
    before(async () => {
      mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
    });
    after(async () => {
      await mcp?.close();
    });

    it('search 도구가 명령줄과 같은 답을 낸다', async () => {
      assert.ok((await mcp.tools()).includes('search'));
      const viaMcp = await mcp.call('search', { query: 'total', kind: 'function,method', limit: 5 });
      const viaCli = fx.ask('search', 'total', '--kind', 'function,method', '--limit', '5');
      assert.deepEqual(viaMcp, viaCli);
    });
  });
});
