// 증분 색인: 예제 저장소의 사본을 고친 뒤 다시 색인한 답이, 같은 상태를 처음부터 색인한 답과 같은지 봐요.
// 예제(test/fixtures/dart_sample) 자체는 고치지 않고 테스트마다 만든 사본만 고쳐요.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexFixture, type IndexedFixture } from './harness.ts';

/** 비교에 쓰는 질문. 고치면서 생기고 없어지는 이름도 넣어요. */
const QUERIES = ['withTax', 'shippingFee', 'add', 'Cart', 'Cart.add', 'Cart.total', 'Wishlist.add', 'discount', 'Coupon', 'Coupon.apply'];

/** 색인한 시각은 색인마다 달라서 빼고 비교해요. */
function answers(ask: (...args: string[]) => any): Record<string, unknown> {
  return Object.fromEntries(
    QUERIES.map((q) => {
      const { index, ...rest } = ask('context', q);
      const { indexedAt, ...indexRest } = index;
      return [q, { index: indexRest, ...rest }];
    }),
  );
}

/** 요약에서 그래프 내용(개수, 언어별)만 꺼내요. */
const graphPart = (s: any) => ({ files: s.files, symbols: s.symbols, relations: s.relations, languages: s.languages });

describe('증분 색인', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('dart_sample');
  });
  after(() => fx?.dispose());

  /** 다시 색인하고, 처음부터 색인한 것과 답과 요약이 같은지 봐요. 증분 요약을 돌려줘요. */
  function reindexAndCompare(): any {
    const summary = fx.reindex();
    const fresh = fx.indexFresh();
    assert.deepEqual(answers(fx.ask), answers(fresh.ask));
    assert.deepEqual(graphPart(summary), graphPart(fresh.summary));
    return summary;
  }

  it('파일 하나를 고치면 그 파일의 사실만 반영하고, 답은 처음부터 색인한 것과 같다', () => {
    fx.append('lib/src/pricing.dart', '\n/// 할인한 가격.\nint discount(int price) => price - 100;\n');
    const summary = reindexAndCompare();
    assert.deepEqual(summary.changes, { added: 0, modified: 1, removed: 0, unchanged: summary.files - 1 });
    assert.equal(fx.ask('context', 'discount').status, 'found');
  });

  it('아무것도 바꾸지 않고 다시 색인하면 반영하는 파일이 없다', () => {
    const summary = fx.reindex();
    assert.deepEqual(summary.changes, { added: 0, modified: 0, removed: 0, unchanged: summary.files });
  });

  it('고친 채로 색인하면 답에 바뀐 파일 있음이 꺼져 있고, 색인 뒤 또 고치면 켜진다', () => {
    assert.notEqual(fx.gitStatus(), '');
    assert.equal(fx.ask('context', 'withTax').index.stale, false);
    fx.append('lib/src/cart.dart', '\n// 색인 뒤에 고침\n');
    assert.equal(fx.ask('context', 'withTax').index.stale, true);
    fx.reindex();
    assert.equal(fx.ask('context', 'withTax').index.stale, false);
  });

  it('파일을 더하면 그 파일만 더하고, 답은 처음부터 색인한 것과 같다', () => {
    fx.write(
      'lib/src/coupon.dart',
      "import 'pricing.dart';\n\nclass Coupon {\n  int apply(int price) => discount(price);\n}\n",
    );
    const summary = reindexAndCompare();
    assert.deepEqual(summary.changes, { added: 1, modified: 0, removed: 0, unchanged: summary.files - 1 });
    assert.equal(fx.ask('context', 'Coupon.apply').status, 'found');
    assert.equal(fx.ask('context', 'discount').uses.total, 1);
  });

  it('파일 이름을 바꾸면 답은 처음부터 색인한 것과 같다(내용이 그대로인 파일이 가리키는 열쇠도 바뀐다)', () => {
    fx.rename('lib/src/pricing.dart', 'lib/src/prices.dart');
    for (const path of ['lib/src/cart.dart', 'lib/src/coupon.dart', 'lib/dart_sample.dart']) {
      fx.write(path, fx.read(path).replace('pricing.dart', 'prices.dart'));
    }
    const summary = reindexAndCompare();
    assert.equal(summary.changes.added, 1);
    assert.equal(summary.changes.removed, 1);
    assert.equal(fx.ask('context', 'withTax').symbol.definition.path, 'lib/src/prices.dart');
  });

  it('파일을 지우면 그 파일의 사실을 빼고, 답은 처음부터 색인한 것과 같다', () => {
    fx.remove('lib/src/coupon.dart');
    const summary = reindexAndCompare();
    assert.deepEqual(summary.changes, { added: 0, modified: 0, removed: 1, unchanged: summary.files });
    assert.equal(fx.ask('context', 'Coupon').status, 'not_found');
    assert.equal(fx.ask('context', 'discount').uses.total, 0);
  });
});
