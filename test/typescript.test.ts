// JavaScript/TypeScript 정밀 색인(scip-typescript): 언어 적합성 묶음(conformance.test.ts) 밖의 약속.
// - 설정 파일이 없는 순수 JavaScript 폴더도 정밀 색인되고, 저장소에 설정 파일을 만들지 않아요.
// - tsconfig의 include 밖 파일(스크립트 등)도 색인해요.
// - scip-typescript가 잇지 못한 이름 자리(JSDoc의 @implements·@type)는 추정 층이 이은 것이 "추정"으로 나와요. 수신자가 any인 멤버는 잇지 않아요.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexFixture, type IndexedFixture } from './harness.ts';

describe('설정 파일이 없는 순수 JavaScript 폴더(js_sample)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('js_sample', {
      // 타입이 없는 수신자(매개변수 x)의 멤버: scip-typescript는 잇지 못해요.
      extraFiles: { 'src/untyped.js': 'function show(x) {\n  return x.label;\n}\n\nmodule.exports = { show };\n' },
    });
  });
  after(() => fx?.dispose());

  it('scip-typescript로 정밀 색인되고, 파일의 언어는 javascript예요', () => {
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['scip-typescript']);
    assert.deepEqual(s.fallbacks, []);
    assert.deepEqual(Object.keys(s.languages), ['javascript']);
    assert.ok(s.languages.javascript.precise > 0.9, JSON.stringify(s.languages));
    assert.equal(fx.ask('context', 'src/pricing.js').file.language, 'javascript');
  });

  it('색인은 저장소에 tsconfig.json 등을 만들지 않아요', () => {
    assert.equal(fx.gitStatus(), '');
    // 무시된 파일까지 봐도(--others) 설정 파일이 새로 생기지 않았어요.
    const others = fx.git('ls-files', '--others').split('\n');
    assert.deepEqual(others.filter((p) => /(ts|js)config\.json$/.test(p)), []);
  });

  it('scip-typescript가 잇지 못한 자리는 추정 층이 이어 추정으로 나와요', () => {
    // JSDoc의 @implements: scip-typescript는 타입 관계로도, occurrence로도 내지 않아요.
    const totaled = fx.ask('context', 'Totaled');
    assert.equal(totaled.symbol.confidence, 'precise');
    assert.deepEqual(
      totaled.uses.items.map((u: any) => [u.path, u.kind, u.confidence, u.kindConfidence, u.source]),
      [['src/cart.js', 'implements', 'inferred', 'inferred', 'tree-sitter-typescript']],
    );
    // JSDoc의 타입 표기(@type {Cart}): 추정으로, 생성자 호출(new Cart())은 정밀로 나와요.
    const cart = fx.ask('context', 'Cart').uses.items.filter((u: any) => u.path === 'src/main.js');
    assert.deepEqual(
      cart.map((u: any) => [u.line, u.kind, u.in, u.confidence, u.source]),
      [
        [12, 'reference', 'main', 'inferred', 'tree-sitter-typescript'],
        [13, 'call', 'main', 'precise', 'scip-typescript'],
      ],
    );
  });

  it('타입을 모르는 수신자(any)의 멤버는 이름만으로 잇지 않아요', () => {
    // 같은 이름 멤버(Labeled.label)가 저장소에 하나뿐이어도요. 정밀 층이 못 이은 멤버는 대개 저장소 밖 값이라서요.
    const label = fx.ask('context', 'label');
    assert.deepEqual(
      label.uses.items.map((u: any) => [u.path, u.confidence]),
      [['src/main.js', 'precise']],
    );
  });
});

describe('tsconfig가 있는 TypeScript 저장소(ts_sample)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('ts_sample', {
      // tsconfig.json의 include(src, test) 밖에 있는 JavaScript 스크립트.
      extraFiles: { 'scripts/report.mjs': "import { withTax } from '../src/pricing.ts';\n\nconsole.log(withTax(1));\n" },
    });
  });
  after(() => fx?.dispose());

  it('tsconfig의 include 밖 파일도 색인하고, TypeScript와 JavaScript가 서로 이어져요', () => {
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['scip-typescript']);
    assert.deepEqual(Object.keys(s.languages).sort(), ['javascript', 'typescript']);
    const uses = fx.ask('context', 'withTax').uses.items;
    const fromScript = uses.find((u: any) => u.path === 'scripts/report.mjs');
    assert.deepEqual(fromScript && [fromScript.kind, fromScript.confidence, fromScript.source], ['call', 'precise', 'scip-typescript']);
  });
});
