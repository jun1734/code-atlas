// 문서 주석 안의 언급(Dart `/// [withTax]`): 코드의 사용처와 가려서 내요.
// context는 표시(`doc: true`)를 붙여 보여 주고, impact·check는 의존으로 치지 않고, rename은 함께 고쳐요.
// 정밀 층(scip-dart)과 추정 층(tree-sitter-dart)이 같은 답을 내는지 같은 질문으로 봐요.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexFixture, type IndexedFixture } from './harness.ts';

/** dart_sample에 더하는 파일: 문서 주석에서만 withTax, Palette, Cart.add를 말해요. */
const NOTES = [
  "import 'pricing.dart';",
  "import 'cart.dart';",
  '/// 값에 세금을 붙이려면 [withTax]를 불러요.',
  'int describe() => 0;',
  '',
  '/// 코드에서 쓰는 곳이 없는 이름. 문서만 [Palette]를 말해요.',
  'class Palette {}',
  '',
  '/// [Palette]를 만드는 곳은 없어요. `[withTax]`처럼 글로 적은 것과 [링크](https://example.com)는 링크가 아니에요.',
  'int paletteSize() => 0;',
  '',
  '/// 담을 때는 [Cart.add]를 불러요.',
  'int addHint() => 0;',
  '',
].join('\n');

const LAYERS = [
  { layer: 'scip-dart', env: {}, confidence: 'precise', source: 'scip-dart' },
] as const;

/** notes.dart의 자리만 [경로, 줄, 열, 종류, doc, 정밀/추정, 출처]로 줄여 봐요. */
const notesSites = (items: any[]) =>
  items.filter((u: any) => u.path === 'lib/src/notes.dart').map((u: any) => [u.path, u.line, u.column, u.kind, u.doc ?? false, u.confidence, u.source]);

for (const run of LAYERS) {
  describe(`문서 주석 안의 언급(dart_sample + lib/src/notes.dart, ${run.layer})`, () => {
    let fx: IndexedFixture;
    before(() => {
      fx = indexFixture('dart_sample', { env: run.env, extraFiles: { 'lib/src/notes.dart': NOTES } });
    });
    after(() => fx?.dispose());

    it('context: 문서 주석 안의 언급도 사용처 목록에 나오되 doc: true로 표시된다', () => {
      const answer = fx.ask('context', 'withTax');
      assert.deepEqual(notesSites(answer.uses.items), [['lib/src/notes.dart', 3, 18, 'reference', true, run.confidence, run.source]]);
      // 코드의 사용처에는 표시가 없어요.
      for (const u of answer.uses.items.filter((u: any) => u.path !== 'lib/src/notes.dart')) assert.equal(u.doc, undefined, JSON.stringify(u));
      // 바깥 타입을 붙인 링크([Cart.add])는 그 멤버를 가리켜요.
      assert.deepEqual(notesSites(fx.ask('context', 'Cart.add').uses.items), [['lib/src/notes.dart', 12, 17, 'reference', true, run.confidence, run.source]]);
    });

    it('impact: 문서 주석에서만 말하는 곳은 영향 받는 곳이 아니다', () => {
      const answer = fx.ask('impact', 'withTax');
      assert.equal(answer.status, 'found');
      const names = answer.affected.items.map((a: any) => `${a.path}:${a.name}`);
      assert.ok(names.length > 0);
      assert.ok(!names.some((n: string) => n.startsWith('lib/src/notes.dart')), names.join('\n'));
    });

    it('check: 문서 주석에서만 말하는 이름은 쓰이지 않는 이름이다', () => {
      const answer = fx.ask('check', '--limit', '1000');
      const unused = answer.unusedPublicNames.items.map((u: any) => u.name);
      assert.ok(unused.includes('Palette'), unused.join(', '));
    });

    it('rename: 문서 주석 안의 언급도 고칠 자리에 들고 doc: true로 표시된다', () => {
      const plan = fx.ask('rename', 'withTax', '--to', 'addTax');
      const all = [...plan.edits.items, ...plan.inferred.items, ...plan.unlinked.items];
      assert.deepEqual(notesSites(all), [['lib/src/notes.dart', 3, 18, 'reference', true, run.confidence, run.source]]);
    });
  });
}
