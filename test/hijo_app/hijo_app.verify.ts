// hijo_app(커밋 7ba0197)을 색인해 check의 답과 map이 그린 코드 지도가 옛 코드 지도와 같은지 봐요.
// 무거워서(색인 1분쯤, flutter pub get) 기본 `npm test`에는 넣지 않았어요. 돌리는 법:
//
//   HIJO_APP_REPO=/path/to/hijo_app npm run verify:hijo
//
// HIJO_APP_REPO는 7ba0197을 가진 hijo_app git 저장소예요. 그 저장소는 읽기만 해요(임시 폴더로 clone해서 씀).
// 정답(expected-7ba0197.json)은 hijo_app의 코드 지도 스크립트(PR #188, scripts/code-map/build.mjs)를
// 같은 커밋에 돌린 결과에서 옮겼어요. 설정은 같은 폴더의 code-atlas.json이에요.
// map은 옛 스크립트를 HIJO_APP_REPO의 기록(OLD_MAP 커밋)에서 꺼내 같은 사본에 그 자리에서 돌려 비교해요.
// 최근 90일 변경 횟수는 돌리는 날에 따라 달라서 정답 파일로 굳히지 않았어요.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runCliRaw } from '../harness.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const COMMIT = '7ba019787559e4c02cea6840a7d646d077753b9d';
/** 옛 코드 지도 스크립트(scripts/code-map/)가 있는 hijo_app 커밋(PR #188). */
const OLD_MAP = '47dbba6';
const want = JSON.parse(readFileSync(join(here, 'expected-7ba0197.json'), 'utf8'));

function cli(...args: string[]): any {
  const r = runCliRaw(args);
  if (r.status !== 0) throw new Error(`명령줄 실패(${r.status}): ${args.join(' ')}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

let work: string;
let answer: any;
/** map이 그린 자료와 옛 스크립트가 그린 자료. */
let drawn: any;
let old: any;

const DATA = /<script type="application\/json" id="code-map-data">([\s\S]*?)<\/script>/;

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

  // 새 지도. 색인이 최신이라 다시 색인하지 않아요.
  const out = join(work, 'map.html');
  const summary = cli('map', '--repo', repo, '--db', db, '--config', join(here, 'code-atlas.json'), '--out', out);
  assert.equal(summary.indexed, false);
  drawn = JSON.parse(DATA.exec(readFileSync(out, 'utf8'))![1]!);

  // 옛 지도. 스크립트를 사본에 넣으면 작업 트리가 바뀌니 새 지도를 그린 뒤에 돌려요.
  const oldDir = join(repo, 'scripts', 'code-map');
  mkdirSync(oldDir, { recursive: true });
  for (const f of ['build.mjs', 'template.html']) {
    writeFileSync(join(oldDir, f), execFileSync('git', ['show', `${OLD_MAP}:scripts/code-map/${f}`], { cwd: source }));
  }
  execFileSync(process.execPath, [join(oldDir, 'build.mjs'), join(work, 'old')], { cwd: repo });
  const oldHtml = readFileSync(join(work, 'old', 'hijo-code-map.html'), 'utf8');
  old = JSON.parse(/const D = (.*);\n/.exec(oldHtml)![1]!);
});
after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('hijo_app 7ba0197 check', () => {

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

// 옛 지도는 경로에서 'lib/'를 떼고 적었어요. 새 지도는 저장소 뿌리 기준 경로 그대로예요.
const short = (p: string) => p.replace(/^lib\//, '');
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 옛 지도와 다르게 나오는 것(이유는 각 it에 적었어요). */
const BARREL_ONLY = 'design_system/components/hijo_pairs.dart';

describe('hijo_app 7ba0197 map', () => {
  it('머리말의 브랜치와 커밋이 같다', () => {
    assert.equal(drawn.commit, COMMIT);
    assert.equal(drawn.head, old.head);
    assert.equal(drawn.branch, old.branch);
  });

  it('파일 찾아보기(파일, 모듈, 줄 수, 90일 변경, 쓰이는 곳, 가져다 쓰는 곳, 테스트)가 같다', () => {
    // 테스트 열 하나만 달라요. 옛 지도는 테스트가 barrel(design_system.dart)을 import하면 barrel이 내보내는 파일을 모두
    // "묶음 경유"로 쳤어요. 새 지도는 테스트가 그 파일의 이름을 실제로 써야 "묶음 경유"예요. hijo_pairs.dart는 barrel에
    // 들었지만 어느 테스트도 그 이름을 쓰지 않아요.
    const mine = drawn.files.map((f: any) => ({ ...f, p: short(f.p) })).sort((a: any, b: any) => byText(a.p, b.p));
    const theirs = old.files
      .map((f: any) => (f.p === BARREL_ONLY ? { ...f, t: 0 } : f))
      .sort((a: any, b: any) => byText(a.p, b.p));
    assert.deepEqual(mine, theirs);
  });

  it('모듈 지도(모듈, 층, 순서, 모듈 사이 import, 흐름을 거스르는 간선, 서로 도는 모듈)가 같다', () => {
    const theirs = old.modules.map((m: any) => (m.name === 'design_system' ? { ...m, untested: m.untested + 1 } : m));
    const byName = (ms: any[]) => [...ms].sort((a, b) => byText(a.name, b.name));
    assert.deepEqual(byName(drawn.modules), byName(theirs)); // design_system의 +1은 위 테스트 열의 hijo_pairs.dart예요.
    assert.deepEqual(drawn.order, old.order);
    const edges = (m: Record<string, string[][]>, f: (p: string) => string) =>
      Object.fromEntries(
        Object.keys(m)
          .sort(byText)
          .map((k) => [k, m[k]!.map((pair) => pair.map(f)).sort()]),
      );
    assert.deepEqual(edges(drawn.medges, short), edges(old.medges, (p) => p));
    assert.deepEqual([...drawn.backEdges].sort(), [...old.backEdges].sort());
    assert.deepEqual([...drawn.cycleMods].sort(), [...old.cycleMods].sort());
  });

  it('흐름을 거스르는 import와 허용 목록 표시가 같다', () => {
    const theirs = old.backEdges
      .flatMap((k: string) => old.medges[k])
      .map(([from, to]: [string, string]) => ({ from, to, allowed: from.startsWith('features/common/') && old.allowed.includes(to) }));
    const mine = drawn.back.map((b: any) => ({ from: short(b.from), to: short(b.to), allowed: b.allowed }));
    const key = (b: any) => `${b.from}>${b.to}`;
    assert.deepEqual(mine.sort((a: any, b: any) => byText(key(a), key(b))), theirs.sort((a: any, b: any) => byText(key(a), key(b))));
  });

  it('서로 물린 파일 묶음(파일, 모듈, 묶음 안 import)이 같다', () => {
    const norm = (cs: any[], f: (p: string) => string) =>
      cs
        .map((c) => ({
          files: c.files.map(f).sort(),
          mods: [...c.mods].sort(),
          edges: c.edges.map((e: string[]) => e.map(f).join(' > ')).sort(),
        }))
        .sort((a, b) => byText(a.files[0], b.files[0]));
    assert.deepEqual(norm(drawn.cycles, short), norm(old.cycles, (p) => p));
  });

  it('리뷰 후보와 종류는 옛 지도의 것에 test_flow.dart 하나를 더한 것이다', () => {
    // check 쪽 테스트와 같은 이유예요: 옛 지도는 비공개 클래스 _PastResultPage를 글자로 찾아 test_flow.dart를 화면으로 봤어요.
    const mine = drawn.reach.map((r: any) => ({ t: short(r.t), from: r.from.map(short).sort(), kind: r.label ? 'model' : 'helper' }));
    const theirs = [
      ...old.reach.map((r: any) => ({ t: r.t, from: [...r.from].sort(), kind: r.kind })),
      { t: 'features/current_state_tests/test_flow.dart', from: ['features/shell/invite_handoff.dart'], kind: 'helper' },
    ];
    const sort = (rs: any[]) => rs.sort((a, b) => byText(a.t, b.t));
    assert.deepEqual(sort(mine), sort(theirs));
  });

  it('외부 SDK가 닿는 파일이 같다', () => {
    const norm = (u: Record<string, string[]>, f: (p: string) => string) =>
      Object.entries(u).map(([k, v]) => [k, v.map(f).sort()]);
    assert.deepEqual(norm(drawn.pkgUse, short), norm(old.pkgUse, (p) => p));
  });
});
