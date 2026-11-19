// Dart 예제 저장소를 실제 scip-dart로 색인하고 명령줄 질문의 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expected, fixtureDir, indexFixture, type IndexedFixture } from './harness.ts';

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
    assert.equal(index.stale, false);
  });

  it('색인 요약에 파일 수, 이름 수, 관계 수, 언어별 정밀/추정 비율, 걸린 시간이 나온다', () => {
    const s = fx.firstSummary;
    const dartFiles = readdirSync(join(fixtureDir, 'dart_sample'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.dart'));
    assert.equal(s.files, dartFiles.length);
    assert.ok(s.symbols > 0 && s.relations > 0);
    // 정밀 색인기(scip-dart)만 돌았으니 관계는 모두 정밀이에요.
    assert.deepEqual(s.languages, { dart: { files: s.files, symbols: s.symbols, relations: s.relations, precise: 1, inferred: 0 } });
    // 처음 색인이라 모든 파일이 새로 들어가요.
    assert.deepEqual(s.changes, { added: s.files, modified: 0, removed: 0, unchanged: 0 });
    for (const part of ['indexers', 'graph', 'total']) assert.ok(Number.isInteger(s.ms[part]) && s.ms[part] >= 0, part);
    assert.ok(s.ms.total >= s.ms.indexers + s.ms.graph);
  });

  it('색인은 예제 저장소의 추적 파일을 바꾸지 않는다', () => {
    assert.equal(fx.gitStatus(), '');
  });

  it('같은 이름이 여럿이면 하나를 고르지 않고 후보를 돌려준다', () => {
    const { index, ...answer } = fx.ask('context', 'add');
    assert.deepEqual(answer, expected('dart_sample', 'context-add.json'));
  });

  it('후보의 바깥 타입을 붙인 이름으로 다시 물으면 그 하나를 돌려준다', () => {
    const { index, ...answer } = fx.ask('context', 'Wishlist.add');
    assert.deepEqual(answer, expected('dart_sample', 'context-Wishlist.add.json'));
  });

  it('사용처가 limit보다 많으면 잘린 사실과 전체 개수를 돌려준다', () => {
    const { uses } = fx.ask('context', 'withTax', '--limit', '1');
    assert.deepEqual(uses, { ...expected('dart_sample', 'context-withTax.json').uses, truncated: true, items: [expected('dart_sample', 'context-withTax.json').uses.items[0]] });
  });

  it('색인 뒤에 파일이 바뀌면 답에 낡았다고 표시한다', () => {
    fx.append('lib/src/pricing.dart', '\n// 바뀜\n');
    try {
      assert.equal(fx.ask('context', 'withTax').index.stale, true);
    } finally {
      fx.restore();
    }
  });
});
