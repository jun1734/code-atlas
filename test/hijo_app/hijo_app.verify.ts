// hijo_app(커밋 7ba0197)을 색인해 check의 답이 지금의 코드 지도와 같은지 봐요.
// 무거워서(색인 1분쯤, flutter pub get) 기본 `npm test`에는 넣지 않았어요. 돌리는 법:
//
//   HIJO_APP_REPO=/path/to/hijo_app npm run verify:hijo
//
// HIJO_APP_REPO는 7ba0197을 가진 hijo_app git 저장소예요. 그 저장소는 읽기만 해요(임시 폴더로 clone해서 씀).
// 정답(expected-7ba0197.json)은 hijo_app의 코드 지도 스크립트(PR #188, scripts/code-map/build.mjs)를
// 같은 커밋에 돌린 결과에서 옮겼어요. 설정은 같은 폴더의 code-atlas.json이에요.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runCliRaw } from '../harness.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const COMMIT = '7ba019787559e4c02cea6840a7d646d077753b9d';
const want = JSON.parse(readFileSync(join(here, 'expected-7ba0197.json'), 'utf8'));

function cli(...args: string[]): any {
  const r = runCliRaw(args);
  if (r.status !== 0) throw new Error(`명령줄 실패(${r.status}): ${args.join(' ')}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('hijo_app 7ba0197 check', () => {
  let work: string;
  let answer: any;
  before(() => {
    const source = process.env.HIJO_APP_REPO;
    if (!source) throw new Error('HIJO_APP_REPO에 hijo_app 저장소 경로를 줘요.');
    work = mkdtempSync(join(tmpdir(), 'code-atlas-hijo-'));
    const repo = join(work, 'hijo_app');
    execFileSync('git', ['clone', '-q', '--no-checkout', source, repo]);
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', COMMIT], { cwd: repo });
    execSync('flutter pub get --enforce-lockfile', { cwd: repo, stdio: 'ignore' });
    const db = join(work, 'atlas.db');
    cli('index', repo, '--db', db);
    answer = cli('check', '--db', db, '--config', join(here, 'code-atlas.json'), '--limit', '1000');
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('색인한 커밋이 7ba0197이고 검사 안 파일 수가 같다', () => {
    assert.equal(answer.index.commit, COMMIT);
    assert.equal(answer.summary.files, want.files);
  });

  it('서로 물린 파일 묶음 5개가 같다', () => {
    assert.equal(answer.summary.cycles, 5);
    assert.deepEqual(answer.cycles.items.map((c: any) => c.files.items), want.cycles);
  });

  it('흐름을 거스르는 import 4개가 같고 모두 허용 목록이다', () => {
    assert.equal(answer.summary.backwardImports, 4);
    assert.equal(answer.summary.new, 0);
    assert.equal(answer.summary.minimal, true);
    assert.deepEqual(
      answer.backwardImports.items.map((b: any) => ({ from: b.from, to: b.to, allowed: b.allowed })),
      want.backwardImports,
    );
  });

  it('모듈 순서와 층이 같다', () => {
    assert.deepEqual(answer.modules.map((m: any) => ({ name: m.name, layer: m.layer })), want.modules);
  });

  it('리뷰 후보는 코드 지도의 것에 test_flow.dart 하나를 더한 것이다', () => {
    // 코드 지도는 test_flow.dart를 글자로 `class _PastResultPage`를 찾아 화면으로 봤어요. scip-dart는 비공개
    // 선언(`_`로 시작)을 지역 심볼로 적어 그래프에 없어서, code-atlas는 이 파일을 화면으로 보지 않아요.
    // shell/invite_handoff.dart가 가져다 쓰는 것은 공개 클래스 CurrentStateTestFlow라 리뷰 후보가 맞아요.
    const extra = { target: 'lib/features/current_state_tests/test_flow.dart', from: ['lib/features/shell/invite_handoff.dart'] };
    const got = answer.reviewCandidates.items
      .map((c: any) => ({ target: c.target, from: c.from }))
      .sort((a: any, b: any) => a.target.localeCompare(b.target));
    const expect = [...want.reviewCandidates, extra].sort((a: any, b: any) => a.target.localeCompare(b.target));
    assert.deepEqual(got, expect);
  });
});
