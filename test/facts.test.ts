// 사실 붙이기(appendFacts): 한 부분(part)의 사실이 아주 많아도 붙어요.
// 이 크기는 예제 저장소로 만들 수 없어서(관계 수십만 개) 색인기가 부르는 함수를 바로 불러요.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendFacts, emptyFacts, type FileFact, type RelationFact, type SymbolFact } from '../src/facts.ts';

/** 함수 호출 하나에 펼침 인자로 넘길 수 있는 수(엔진마다 다르고 십만 남짓)를 넉넉히 넘는 개수. */
const MANY = 400_000;

const RANGE = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 };

const file = (i: number): FileFact => ({ path: `lib/f${i}.dart`, language: 'dart', role: 'app' });

const symbol = (i: number): SymbolFact => ({
  key: `k${i}`,
  name: `n${i}`,
  qualifiedName: `n${i}`,
  kind: 'function',
  path: 'lib/a.dart',
  range: RANGE,
  confidence: 'precise',
  source: 'test',
});

const relation = (i: number): RelationFact => ({
  kind: 'call',
  from: { path: 'lib/a.dart', range: RANGE },
  to: { symbolKey: `k${i}` },
  confidence: 'precise',
  kindConfidence: 'precise',
  source: 'test',
});

const many = <T>(make: (i: number) => T): T[] => Array.from({ length: MANY }, (_, i) => make(i));

/** 앞에 있던 것 하나 뒤에 part의 것이 순서대로 붙었는지. */
function assertAppended<T>(got: T[], first: T, part: T[]): void {
  assert.equal(got.length, part.length + 1);
  assert.equal(got[0], first);
  for (let i = 0; i < part.length; i++) {
    if (got[i + 1] !== part[i]) assert.fail(`${i}번째가 제자리에 없어요`);
  }
}

describe('appendFacts', () => {
  it('관계가 아주 많은 부분을 붙여도 던지지 않고 순서를 지킨다', () => {
    const first = relation(-1);
    const into = { ...emptyFacts(), relations: [first] };
    const part = { ...emptyFacts(), relations: many(relation) };
    appendFacts(into, part);
    assertAppended(into.relations, first, part.relations);
  });

  it('파일이 아주 많은 부분도 같은 방식으로 붙인다', () => {
    const first = file(-1);
    const into = { ...emptyFacts(), files: [first] };
    const part = { ...emptyFacts(), files: many(file) };
    appendFacts(into, part);
    assertAppended(into.files, first, part.files);
  });

  it('심볼이 아주 많은 부분도 같은 방식으로 붙인다', () => {
    const first = symbol(-1);
    const into = { ...emptyFacts(), symbols: [first] };
    const part = { ...emptyFacts(), symbols: many(symbol) };
    appendFacts(into, part);
    assertAppended(into.symbols, first, part.symbols);
  });
});
