// 추정 층(Tree-sitter): 정밀 색인기가 없거나 덮지 못한 파일을 구문으로 읽고 이름으로 이어 색인해요.
// 정밀 색인기를 지우지 않고 "없는 것"으로 치려면 색인 명령에 CODE_ATLAS_DISABLE_INDEXERS를 줘요.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexFixture, type IndexedFixture } from './harness.ts';

const NO_SCIP_DART = { CODE_ATLAS_DISABLE_INDEXERS: 'scip-dart' };

/** 답 안에서 confidence가 붙은 항목을 모두 모아요. */
function marked(value: unknown, out: { confidence: string; source: string; kindConfidence?: string }[] = []) {
  if (Array.isArray(value)) for (const v of value) marked(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.confidence === 'string') out.push(o as any);
    for (const v of Object.values(o)) marked(v, out);
  }
  return out;
}

describe('정밀 색인기가 없을 때(dart_sample, scip-dart 없음)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('dart_sample', { env: NO_SCIP_DART });
  });
  after(() => fx?.dispose());

  it('무엇을 어떻게 설치하는지 안내가 나오고, 그 언어는 추정 층으로 색인이 끝난다', () => {
    assert.match(fx.firstLog, /scip-dart/);
    assert.match(fx.firstLog, /dart pub global activate scip_dart 1\.8\.1/);
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['tree-sitter-dart']);
    assert.deepEqual(s.fallbacks, [
      {
        language: 'dart',
        indexer: 'scip-dart',
        reason: 'missing',
        install: 'dart pub global activate scip_dart 1.8.1',
        inferredBy: 'tree-sitter-dart',
      },
    ]);
    assert.equal(s.languages.dart.inferred, 1);
    assert.equal(s.languages.dart.precise, 0);
    const answer = fx.ask('context', 'withTax');
    assert.equal(answer.status, 'found');
    assert.equal(answer.symbol.definition.path, 'lib/src/pricing.dart');
  });

  it('추정 층에서 나온 이름과 관계는 답에 모두 추정으로 나온다', () => {
    const answers = [
      fx.ask('context', 'withTax'),
      fx.ask('context', 'Cart'),
      fx.ask('context', 'lib/src/pricing.dart'),
      fx.ask('impact', 'withTax'),
      fx.ask('search', 'cart'),
      fx.ask('trace', 'bin/checkout.dart', '--to', 'withTax'),
    ];
    const items = answers.flatMap((a) => marked(a));
    assert.ok(items.length > 20, `표시가 붙은 항목 ${items.length}개`);
    for (const item of items) {
      assert.equal(item.confidence, 'inferred', JSON.stringify(item));
      assert.equal(item.source, 'tree-sitter-dart', JSON.stringify(item));
      if (item.kindConfidence !== undefined) assert.equal(item.kindConfidence, 'inferred', JSON.stringify(item));
    }
  });
});

/** 추정 층 Dart 규칙을 보는 작은 파일(dart_sample에 더해요). */
const PALETTE = [
  'class Palette {',
  '  const Palette({required this.primary});',
  '  final int primary;',
  '}',
  '',
  'class Swatch {',
  '  Swatch(this.shade);',
  '  final int shade;',
  '}',
  '',
  'const defaultPalette = Palette(primary: 1);',
  'final defaultSwatch = Swatch(2);',
  '',
].join('\n');

describe('추정 층 Dart 규칙(dart_sample + lib/src/palette.dart, scip-dart 없음)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('dart_sample', { env: NO_SCIP_DART, extraFiles: { 'lib/src/palette.dart': PALETTE } });
  });
  after(() => fx?.dispose());

  const uses = (answer: any) => answer.uses.items.map((u: any) => [u.path, u.line, u.column, u.kind]);

  it('이름 없는 생성자 선언(const든 아니든)은 클래스의 사용처가 아니다', () => {
    assert.deepEqual(uses(fx.ask('context', 'Palette')), [['lib/src/palette.dart', 11, 24, 'call']]);
    assert.deepEqual(uses(fx.ask('context', 'Swatch')), [['lib/src/palette.dart', 12, 23, 'call']]);
  });
});

describe('정밀 층과 추정 층이 섞인 저장소(mixed_sample: app/ 패키지는 scip-dart, 패키지 밖 scripts/는 추정 층)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('mixed_sample', { pubGetIn: ['app'] });
  });
  after(() => fx?.dispose());

  it('정밀 색인이 있는 파일의 사실은 추정 층이 덮어쓰지 않고, 정밀 색인기가 덮지 못한 파일만 추정 층이 메운다', () => {
    const s = fx.firstSummary;
    assert.deepEqual(s.adapters, ['scip-dart', 'tree-sitter-dart']);
    assert.deepEqual(s.fallbacks, []);
    assert.equal(fx.firstLog, '');
    assert.ok(s.languages.dart.precise > 0 && s.languages.dart.inferred > 0, JSON.stringify(s.languages));

    // 패키지 안의 이름은 정밀 정의 하나뿐이에요(추정 정의가 겹쳐 생기면 ambiguous가 돼요).
    const cart = fx.ask('context', 'Cart');
    assert.equal(cart.status, 'found');
    assert.deepEqual([cart.symbol.confidence, cart.symbol.source], ['precise', 'scip-dart']);
    // 패키지 밖에서 쓰는 곳은 추정 층이 이어 줘요.
    assert.deepEqual(
      cart.uses.items.map((u: any) => [u.path, u.line, u.kind, u.in, u.confidence, u.source]),
      [['scripts/report.dart', 5, 'call', 'buildReport', 'inferred', 'tree-sitter-dart']],
    );

    // 패키지 안 파일의 사실은 모두 정밀 그대로예요.
    for (const path of ['app/lib/cart.dart', 'app/lib/money.dart']) {
      const file = fx.ask('context', path);
      assert.equal(file.status, 'found', path);
      for (const item of [...file.defines.items, ...file.imports.items]) assert.equal(item.source, 'scip-dart', JSON.stringify(item));
    }
    const script = fx.ask('context', 'scripts/report.dart');
    assert.deepEqual(
      script.defines.items.map((d: any) => [d.name, d.kind, d.confidence, d.source]),
      [
        ['buildReport', 'function', 'inferred', 'tree-sitter-dart'],
        ['main', 'function', 'inferred', 'tree-sitter-dart'],
      ],
    );
    assert.deepEqual(
      script.imports.items.map((i: any) => [i.path, i.confidence, i.source]),
      [['app/lib/cart.dart', 'inferred', 'tree-sitter-dart']],
    );
  });

  it('impact: 추정 관계를 거쳐 닿은 곳은 inferred, 정밀 관계로만 닿은 곳은 precise로 나온다', () => {
    const answer = fx.ask('impact', 'withVat');
    assert.equal(answer.status, 'found');
    assert.deepEqual(
      answer.affected.items.map((i: any) => [i.distance, i.path, i.name, i.confidence, i.source]),
      [
        [1, 'app/lib/cart.dart', 'Cart.total', 'precise', 'scip-dart'],
        [2, 'scripts/report.dart', 'buildReport', 'inferred', 'tree-sitter-dart'],
        [3, 'scripts/report.dart', 'main', 'inferred', 'tree-sitter-dart'],
      ],
    );
  });

  it('trace: 추정 구간을 지나는 경로는 그 구간과 경로 전체에 inferred 표시가 붙는다', () => {
    const answer = fx.ask('trace', 'main', '--to', 'withVat');
    assert.equal(answer.status, 'found');
    assert.equal(answer.paths.total, 1);
    const [path] = answer.paths.items;
    assert.deepEqual(path.nodes.map((n: any) => n.name), ['main', 'buildReport', 'Cart.total', 'withVat']);
    assert.deepEqual(
      path.steps.map((s: any) => [s.from, s.to, s.kind, s.confidence, s.source]),
      [
        ['main', 'buildReport', 'call', 'inferred', 'tree-sitter-dart'],
        ['buildReport', 'Cart.total', 'call', 'inferred', 'tree-sitter-dart'],
        ['Cart.total', 'withVat', 'call', 'precise', 'scip-dart'],
      ],
    );
    assert.equal(path.confidence, 'inferred');
    assert.equal(path.kindConfidence, 'inferred');
  });
});

describe('정밀 색인기가 실패할 때(dart_sample, pub get 안 함)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('dart_sample', { pubGetIn: [] });
  });
  after(() => fx?.dispose());

  it('실패 내용과 할 일이 안내되고, 색인은 멈추지 않고 그 언어를 추정 층으로 끝낸다', () => {
    assert.match(fx.firstLog, /scip-dart\(dart 정밀 색인기\)가 실패했어요/);
    assert.match(fx.firstLog, /pub get/);
    const [fallback] = fx.firstSummary.fallbacks;
    assert.equal(fallback.reason, 'failed');
    assert.equal(fallback.inferredBy, 'tree-sitter-dart');
    assert.match(fallback.error, /pub get/);
    assert.deepEqual(fx.firstSummary.adapters, ['tree-sitter-dart']);
    assert.equal(fx.ask('context', 'withTax').uses.total, 4);
  });
});
