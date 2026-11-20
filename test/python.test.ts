// Python 색인(정밀: scip-python, 추정: tree-sitter-python). 언어 적합성 묶음(conformance.test.ts의 python_sample) 밖의 것:
// Dart와 Python이 섞인 저장소를 한 번에 색인하고 언어를 모른 채 묻기, scip-python이 없을 때 추정 층으로 메우기.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexFixture, type IndexedFixture } from './harness.ts';

/** 사용처 목록을 비교하기 쉬운 꼴로. */
const uses = (answer: any) => answer.uses.items.map((u: any) => [u.path, u.line, u.kind, u.in ?? null, u.confidence, u.source]);

describe('Dart와 Python이 섞인 저장소(polyglot_sample: app/은 Dart 패키지, functions/는 Python 프로젝트, tools/는 프로젝트 밖 스크립트)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('polyglot_sample', { pubGetIn: ['app'] });
  });
  after(() => fx?.dispose());

  it('한 번의 색인으로 두 언어가 모두 정밀 색인되고, 프로젝트 밖 Python 파일은 추정 층이 메운다', () => {
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['scip-dart', 'scip-python', 'tree-sitter-python']);
    assert.deepEqual(s.fallbacks, []);
    assert.equal(fx.firstLog, '');
    assert.deepEqual(Object.keys(s.languages).sort(), ['dart', 'python']);
    assert.equal(s.languages.dart.precise, 1);
    assert.ok(s.languages.python.precise > 0 && s.languages.python.inferred > 0, JSON.stringify(s.languages));
  });

  it('언어를 밝히지 않고 묻는다: 두 언어에 같은 이름이 있으면 후보로, 후보의 key로 다시 물으면 그 언어의 답이 나온다', () => {
    const answer = fx.ask('context', 'withTax');
    assert.equal(answer.status, 'ambiguous');
    assert.deepEqual(
      answer.candidates.map((c: any) => [c.definition.path, c.source]),
      [
        ['app/lib/money.dart', 'scip-dart'],
        ['functions/billing/tax.py', 'scip-python'],
      ],
    );
    const dart = fx.ask('context', answer.candidates[0].key);
    assert.deepEqual(uses(dart), [['app/lib/cart.dart', 6, 'call', 'Cart.total', 'precise', 'scip-dart']]);
    const python = fx.ask('context', answer.candidates[1].key);
    assert.deepEqual(uses(python), [
      ['functions/billing/__init__.py', 1, 'reference', null, 'precise', 'scip-python'],
      ['functions/billing/tax.py', 7, 'call', 'formatReceipt', 'precise', 'scip-python'],
    ]);
  });

  it('한 언어에만 있는 이름은 바로 나온다(Python: 패키지를 거쳐 `모듈.이름`으로 부르는 곳, Dart: 클래스)', () => {
    const receipt = fx.ask('context', 'formatReceipt');
    assert.equal(receipt.status, 'found');
    assert.deepEqual([receipt.symbol.kind, receipt.symbol.source], ['function', 'scip-python']);
    assert.deepEqual(uses(receipt), [
      ['functions/billing/__init__.py', 1, 'reference', null, 'precise', 'scip-python'],
      ['functions/main.py', 5, 'call', 'handle', 'precise', 'scip-python'],
    ]);
    const cart = fx.ask('context', 'Cart');
    assert.deepEqual([cart.status, cart.symbol.definition.path, cart.symbol.source], ['found', 'app/lib/cart.dart', 'scip-dart']);
  });

  it('search는 두 언어를 함께 찾고, 언어로 좁힐 수 있다', () => {
    const all = fx.ask('search', 'tax');
    assert.deepEqual(all.results.items.map((i: any) => i.language).sort(), ['dart', 'python']);
    const python = fx.ask('search', 'tax', '--language', 'python');
    assert.deepEqual(python.results.items.map((i: any) => i.definition.path), ['functions/billing/tax.py']);
  });

  it('파일로 물으면 Python import(절대 import로 가져온 패키지)와 프로젝트 밖 스크립트의 추정 정의가 나온다', () => {
    const main = fx.ask('context', 'functions/main.py');
    assert.deepEqual(
      main.imports.items.map((i: any) => [i.path, i.confidence, i.source]),
      [['functions/billing/__init__.py', 'precise', 'scip-python']],
    );
    const script = fx.ask('context', 'tools/report.py');
    assert.deepEqual(
      script.defines.items.map((d: any) => [d.name, d.kind, d.confidence, d.source]),
      [['summarize', 'function', 'inferred', 'tree-sitter-python']],
    );
  });
});

describe('scip-python이 없을 때(polyglot_sample, scip-python 없음)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('polyglot_sample', { pubGetIn: ['app'], env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-python' } });
  });
  after(() => fx?.dispose());

  it('무엇을 어떻게 설치하는지 안내가 나오고, Python은 추정 층으로, Dart는 그대로 정밀로 색인된다', () => {
    assert.match(fx.firstLog, /scip-python/);
    assert.match(fx.firstLog, /@sourcegraph\/scip-python@0\.6\.8/);
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['scip-dart', 'tree-sitter-python']);
    assert.deepEqual(s.fallbacks.map((f: any) => [f.language, f.indexer, f.reason, f.inferredBy]), [['python', 'scip-python', 'missing', 'tree-sitter-python']]);
    assert.equal(s.languages.dart.precise, 1);
    assert.equal(s.languages.python.inferred, 1);
    const receipt = fx.ask('context', 'formatReceipt');
    assert.deepEqual([receipt.symbol.confidence, receipt.symbol.source], ['inferred', 'tree-sitter-python']);
    assert.deepEqual(uses(receipt), [
      ['functions/billing/__init__.py', 1, 'reference', null, 'inferred', 'tree-sitter-python'],
      ['functions/main.py', 5, 'call', 'handle', 'inferred', 'tree-sitter-python'],
    ]);
  });
});
