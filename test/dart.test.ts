// Dart 예제 저장소를 실제 scip-dart로 색인하고 명령줄 질문의 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, type IndexedFixture } from './harness.ts';

describe('dart_sample', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('dart_sample');
  });
  after(() => fx?.dispose());

  it('context는 함수의 정의 위치, 종류, 사용처(barrel을 거친 것 포함)를 돌려준다', () => {
    const { index, ...answer } = fx.ask('context', 'withTax');
    assert.deepEqual(answer, expected('dart_sample', 'context-withTax.json'));
    assert.equal(index.commit, fx.head());
  });

  it('색인은 예제 저장소의 추적 파일을 바꾸지 않는다', () => {
    assert.equal(fx.gitStatus(), '');
  });

  it('같은 이름이 여럿이면 하나를 고르지 않고 후보를 돌려주고, 후보 이름으로 다시 물을 수 있다', () => {
    const { index, ...answer } = fx.ask('context', 'add');
    assert.deepEqual(answer, expected('dart_sample', 'context-add.json'));
    const again = fx.ask('context', 'Wishlist.add');
    assert.equal(again.status, 'found');
    assert.deepEqual(again.symbol.definition, { path: 'lib/src/cart.dart', line: 20, column: 8 });
    assert.deepEqual(again.uses, { total: 0, truncated: false, items: [] });
  });

  it('사용처가 limit보다 많으면 잘린 사실과 전체 개수를 돌려준다', () => {
    const answer = fx.ask('context', 'withTax', '--limit', '1');
    assert.equal(answer.uses.total, 3);
    assert.equal(answer.uses.truncated, true);
    assert.equal(answer.uses.items.length, 1);
  });
});
