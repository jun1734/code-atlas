// 구조 검사(check): 모듈 구조가 있는 예제 저장소를 실제 scip-dart로 색인하고, 명령줄과 MCP의 check 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, startMcp, type IndexedFixture, type McpSession } from './harness.ts';

describe('modular_sample check', () => {
  let home: string;
  let fx: IndexedFixture;
  let mcp: McpSession;
  let answer: any;
  const want = expected('modular_sample', 'check.json');
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('modular_sample', { home });
    answer = fx.ask('check');
    mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
  });
  after(async () => {
    await mcp?.close();
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('저장소 뿌리의 .code-atlas.json을 읽고, 답에 봉투(index)를 씌운다', () => {
    assert.equal(answer.config, '.code-atlas.json');
    assert.equal(answer.index.repo, fx.repo);
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
    const byAllowed = Object.fromEntries(answer.backwardImports.items.map((b: any) => [b.to, b.allowed]));
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

  it('목록은 limit으로 잘리고 전체 개수와 잘린 사실을 함께 낸다', () => {
    const cut = fx.ask('check', '--limit', '1');
    assert.deepEqual(cut.cycles, { ...want.cycles, truncated: true, items: want.cycles.items.slice(0, 1) });
    assert.equal(cut.unusedPublicNames.total, 2);
    assert.equal(cut.unusedPublicNames.items.length, 1);
  });

  it('--config로 준 설정이 모듈 기준을 바꾼다(허용 목록이 없으면 모두 새 위반)', () => {
    const config = fileURLToPath(new URL('./configs/modular_sample-plain.json', import.meta.url));
    const plain = fx.ask('check', '--config', config);
    assert.deepEqual(plain.modules.map((m: any) => m.name), ['orders', 'app', 'catalog']);
    assert.deepEqual(
      plain.backwardImports.items.map((b: any) => [b.from, b.to, b.allowed]),
      [
        ['lib/app.dart', 'lib/features/orders/orders_page.dart', false],
        ['lib/features/catalog/catalog_list.dart', 'lib/shared/strings.dart', false],
        ['lib/features/catalog/catalog_page.dart', 'lib/shared/header.dart', false],
        ['lib/shared/toast.dart', 'lib/features/orders/order_status.dart', false],
      ],
    );
    assert.equal(plain.summary.new, 4);
  });

  it('MCP 도구 check도 명령줄과 같은 답을 돌려준다', async () => {
    assert.ok((await mcp.tools()).includes('check'));
    assert.deepEqual(await mcp.call('check', {}), answer);
  });
});

describe('allowlist_sample check (허용은 가져다 쓰는 쪽과 대상의 쌍)', () => {
  let fx: IndexedFixture;
  before(() => {
    fx = indexFixture('allowlist_sample');
  });
  after(() => fx?.dispose());

  it('허용 목록의 출발 모듈이 가져오면 허용, 다른 모듈이 같은 대상을 거꾸로 가져오면 새 위반이다', () => {
    const answer = fx.ask('check');
    assert.deepEqual(
      answer.backwardImports.items.map((b: any) => [b.from, b.fromModule, b.to, b.allowed]),
      [
        ['lib/common/frame.dart', 'common', 'lib/features/menu/menu_page.dart', true],
        ['lib/util/fmt.dart', 'util', 'lib/features/menu/menu_page.dart', false],
      ],
    );
    assert.equal(answer.summary.allowed, 1);
    assert.equal(answer.summary.new, 1);
  });
});
