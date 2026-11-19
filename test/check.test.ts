// 구조 검사(check): 모듈 구조가 있는 예제 저장소를 실제 scip-dart로 색인하고, 명령줄 check의 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, type IndexedFixture } from './harness.ts';

describe('modular_sample check', () => {
  let fx: IndexedFixture;
  let answer: any;
  const want = expected('modular_sample', 'check.json');
  before(() => {
    fx = indexFixture('modular_sample');
    answer = fx.ask('check');
  });
  after(() => fx?.dispose());

  it('저장소 뿌리의 .code-atlas.json을 읽고, 답에 색인 기준 커밋과 낡았는지를 넣는다', () => {
    assert.equal(answer.config, '.code-atlas.json');
    assert.equal(answer.index.commit, fx.head());
    assert.equal(answer.index.stale, false);
  });

  it('서로 물린 파일 묶음이 나온다(모듈을 넘는 것 포함, part of는 묶음을 만들지 않는다)', () => {
    assert.deepEqual(answer.cycles, want.cycles);
  });

  it('모듈 사이에서 흐름을 거스르는 import와 그 최소 개수, 모듈별 층이 나온다', () => {
    assert.deepEqual(answer.modules, want.modules);
    assert.deepEqual(answer.backwardImports, want.backwardImports);
    assert.equal(answer.summary.backwardImports, 2);
    assert.equal(answer.summary.minimal, true);
  });

  it('허용 목록에 든 것과 새 위반을 구분한다', () => {
    const byAllowed = Object.fromEntries(answer.backwardImports.map((b: any) => [b.to, b.allowed]));
    assert.deepEqual(byAllowed, {
      'lib/features/catalog/catalog_provider.dart': true,
      'lib/features/orders/order_status.dart': false,
    });
    assert.equal(answer.summary.allowed, 1);
    assert.equal(answer.summary.new, 1);
  });

  it('다른 기능 폴더의 화면도 provider도 아닌 것을 가져다 쓰는 곳이 리뷰 후보로 나온다', () => {
    assert.deepEqual(answer.reviewCandidates, want.reviewCandidates);
  });

  it('어디서도 쓰이지 않는 공개 이름 목록이 나온다(생성자로만 쓰인 클래스와 비공개 이름은 빠진다)', () => {
    assert.deepEqual(answer.unusedPublicNames, want.unusedPublicNames);
  });

  it('답 전체가 정답과 같다', () => {
    const { index, ...rest } = answer;
    assert.deepEqual(rest, want);
  });

  it('--config로 준 설정이 모듈 기준을 바꾼다(허용 목록이 없으면 모두 새 위반)', () => {
    const config = fileURLToPath(new URL('./configs/modular_sample-plain.json', import.meta.url));
    const plain = fx.ask('check', '--config', config);
    assert.deepEqual(plain.modules.map((m: any) => m.name), ['orders', 'app', 'catalog']);
    assert.deepEqual(
      plain.backwardImports.map((b: any) => [b.from, b.to, b.allowed]),
      [
        ['lib/features/catalog/catalog_list.dart', 'lib/shared/strings.dart', false],
        ['lib/features/catalog/catalog_page.dart', 'lib/shared/header.dart', false],
        ['lib/app.dart', 'lib/features/orders/orders_page.dart', false],
        ['lib/shared/toast.dart', 'lib/features/orders/order_status.dart', false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
    );
    assert.equal(plain.summary.new, 4);
  });
});
