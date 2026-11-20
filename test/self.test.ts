// 도구 자신의 저장소(code-atlas)를 색인해 context와 impact를 물어요(hijo#221 "도구 자신의 저장소를 색인해 context와 impact를 쓸 수 있다").
// 저장소는 읽기만 해요. 색인 파일은 임시 폴더에 둬요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runCliRaw } from './harness.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));

describe('도구 자신의 저장소(code-atlas)', () => {
  let work: string;
  let db: string;
  const ask = (...args: string[]) => {
    const r = runCliRaw([...args, '--db', db]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'code-atlas-self-'));
    db = join(work, 'atlas.db');
    const r = runCliRaw(['index', repo, '--db', db]);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('context: 도구의 이름(runInferred)이 정밀로 찾아지고, 그것을 부르는 곳이 나온다', () => {
    const answer = ask('context', 'runInferred');
    assert.equal(answer.status, 'found');
    assert.deepEqual(
      [answer.symbol.kind, answer.symbol.definition.path, answer.symbol.confidence, answer.symbol.source],
      ['function', 'src/inferred/layer.ts', 'precise', 'scip-typescript'],
    );
    const callers = answer.uses.items.filter((u: any) => u.kind === 'call').map((u: any) => `${u.path}#${u.in}`);
    assert.ok(callers.includes('src/indexer.ts#indexLanguage'), callers.join('\n'));
    assert.ok(callers.includes('src/adapters/typescript-refine.ts#fillGaps'), callers.join('\n'));
  });

  it('impact: 도구의 이름을 바꾸면 영향 받는 곳이 거리와 함께 나온다', () => {
    const answer = ask('impact', 'runInferred');
    assert.equal(answer.target.name, 'runInferred');
    const at = (path: string, name: string) => answer.affected.items.find((a: any) => a.path === path && a.name === name);
    // 바로 부르는 곳(거리 1)과 그것을 부르는 곳(거리 2).
    assert.equal(at('src/indexer.ts', 'indexLanguage')?.distance, 1);
    assert.equal(at('src/indexer.ts', 'indexRepo')?.distance, 2);
  });
});
