// 언어 적합성 묶음: 같은 질문(test/conformance/questions.ts)을 언어마다 같은 모양의 예제 저장소에 던지고
// 언어별 정답과 비교해요. 새 언어는 예제 저장소와 정답 폴더를 만들고 RUNS에 더해요.
//
// 층마다 돌려요.
// - precise: 정밀 색인기로 색인해 정답(`test/expected/<예제>/conformance/<질문>.json`)과 그대로 비교해요.
// - inferred: 정밀 색인기를 없는 것으로 치고(추정 층만) 색인해요. 표시(confidence, kindConfidence, source, key)를 뺀 답이
//   정밀 정답과 같으면 "통과", 다르면 "놓침"이에요. 질문마다의 통과/놓침은 docs/architecture.md의
//   "추정 층 적합성: <예제>" 표에 적혀 있고, 이 테스트가 표와 맞는지 봐요. 놓친 질문은 그 답을
//   `test/expected/<예제>/conformance-inferred/<질문>.json`에 두고 같은지 봐요(놓치는 모양이 바뀌면 알아채려고요).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { QUESTIONS } from './conformance/questions.ts';
import { expected, expectedPath, indexFixture, type IndexedFixture } from './harness.ts';

interface Run {
  fixture: string;
  layer: 'precise' | 'inferred';
  /** 색인 명령의 환경 변수(추정 층만 돌리려면 정밀 색인기를 없는 것으로 쳐요). */
  env?: Record<string, string>;
  /** 추정 층의 출처 이름(답의 모든 항목이 이것이어야 해요). */
  inferredSource?: string;
}

const RUNS: Run[] = [
  { fixture: 'dart_sample', layer: 'precise' },
  { fixture: 'dart_sample', layer: 'inferred', env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-dart' }, inferredSource: 'tree-sitter-dart' },
  { fixture: 'ts_sample', layer: 'precise' },
  { fixture: 'ts_sample', layer: 'inferred', env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-typescript' }, inferredSource: 'tree-sitter-typescript' },
  // 설정 파일(package.json, tsconfig.json, jsconfig.json)이 없는 순수 JavaScript(CommonJS) 폴더예요.
  { fixture: 'js_sample', layer: 'precise' },
  { fixture: 'js_sample', layer: 'inferred', env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-typescript' }, inferredSource: 'tree-sitter-typescript' },
];

/** 표시(믿음, 출처, 열쇠)를 뺀 답. 추정 층이 정밀 층과 같은 것을 찾았는지 볼 때 써요. */
function withoutMarks(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutMarks);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !['confidence', 'kindConfidence', 'source', 'key'].includes(k))
        .map(([k, x]) => [k, withoutMarks(x)]),
    );
  }
  return v;
}

/** 답 안에서 confidence가 붙은 항목을 모두 모아요. */
function marked(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) marked(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.confidence === 'string') out.push(o);
    for (const v of Object.values(o)) marked(v, out);
  }
  return out;
}

/** docs/architecture.md의 "추정 층 적합성: <예제>" 표: 질문 id → '통과' | '놓침'. */
function recordedResults(fixture: string): Map<string, string> {
  const doc = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  const start = doc.indexOf(`### 추정 층 적합성: ${fixture}`);
  assert.ok(start >= 0, `docs/architecture.md에 "### 추정 층 적합성: ${fixture}" 절이 없어요`);
  const section = doc.slice(start + 1).split(/\n#{2,3} /)[0]!;
  const rows = new Map<string, string>();
  for (const m of section.matchAll(/^\| `([\w-]+)` \| (통과|놓침) \|/gm)) rows.set(m[1]!, m[2]!);
  return rows;
}

for (const run of RUNS) {
  const { fixture } = run;
  describe(`언어 적합성: ${fixture} (${run.layer === 'precise' ? '정밀 층' : '추정 층'})`, () => {
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
    const recorded = run.layer === 'inferred' ? recordedResults(fixture) : null;

    before(() => {
      fx = indexFixture(fixture, run.env ? { env: run.env } : {});
    });
    after(() => fx?.dispose());

    if (recorded) {
      it('문서의 통과/놓침 표에 질문이 모두 있다', () => {
        assert.deepEqual([...recorded.keys()].sort(), QUESTIONS.map((q) => q.id).sort());
      });
    }

    for (const q of QUESTIONS) {
      it(`${q.id}: ${q.why}`, () => {
        const { index, ...answer } = fx.ask(...q.args.map(fill));
        const want = expected(fixture, `conformance/${q.id}.json`);
        if (run.layer === 'precise') assert.deepEqual(answer, want);
        else {
          const result = isDeepStrictEqual(withoutMarks(answer), withoutMarks(want)) ? '통과' : '놓침';
          assert.equal(result, recorded!.get(q.id), `${q.id}: 문서에는 ${recorded!.get(q.id)}, 실제는 ${result}`);
          if (result === '놓침') assert.deepEqual(answer, expected(fixture, `conformance-inferred/${q.id}.json`));
          // 추정 층만 돌았으니 답의 모든 항목이 추정이에요.
          for (const item of marked(answer)) {
            assert.equal(item.confidence, 'inferred', JSON.stringify(item));
            assert.equal(item.source, run.inferredSource, JSON.stringify(item));
            if (item.kindConfidence !== undefined) assert.equal(item.kindConfidence, 'inferred', JSON.stringify(item));
          }
        }
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
