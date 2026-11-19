// 언어 적합성 묶음: 같은 질문(test/conformance/questions.ts)을 언어마다 같은 모양의 예제 저장소에 던지고
// 언어별 정답과 비교해요. 새 언어는 예제 저장소와 정답 폴더를 만들고 FIXTURES에 이름을 더해요.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { QUESTIONS } from './conformance/questions.ts';
import { expected, expectedPath, indexFixture, type IndexedFixture } from './harness.ts';

const FIXTURES = ['dart_sample'];

for (const fixture of FIXTURES) {
  describe(`언어 적합성: ${fixture}`, () => {
    let fx: IndexedFixture;
    const values: Record<string, string> = existsSync(expectedPath(fixture, 'conformance/fixture.json'))
      ? expected(fixture, 'conformance/fixture.json')
      : {};
    const fill = (arg: string) =>
      arg.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = values[name];
        if (v === undefined) throw new Error(`${fixture}의 conformance/fixture.json에 ${name}이 없어요`);
        return v;
      });

    before(() => {
      fx = indexFixture(fixture);
    });
    after(() => fx?.dispose());

    for (const q of QUESTIONS) {
      it(`${q.id}: ${q.why}`, () => {
        const { index, ...answer } = fx.ask(...q.args.map(fill));
        assert.deepEqual(answer, expected(fixture, `conformance/${q.id}.json`));
        if (q.then === 'reask-candidates-by-key') {
          assert.equal(answer.status, 'ambiguous');
          for (const candidate of answer.candidates) {
            const again = fx.ask('context', candidate.key);
            assert.equal(again.status, 'found', candidate.key);
            assert.deepEqual(again.symbol.definition, candidate.definition);
          }
        }
      });
    }
  });
}
