// 변경 영향(detect_changes): 예제 저장소를 실제 scip-dart로 색인하고, 작업 트리를 고치거나 커밋을 쌓은 뒤
// 명령줄과 MCP의 detect_changes 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { indexFixture, startMcp, unmarked, type IndexedFixture, type McpSession } from './harness.ts';

/** 건드린 이름을 `바뀜 경로#이름` 꼴로(답의 순서 그대로). */
function changed(answer: any): string[] {
  return answer.changes.items.map((c: any) => `${c.change} ${c.path}#${c.name}`);
}

describe('changes_sample detect_changes (작업 트리)', () => {
  let home: string;
  let fx: IndexedFixture;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('changes_sample', { home });
  });
  afterEach(() => fx.restore());
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('줄만 바뀌고 이름은 그대로인 변경: 본문을 고친 이름만 나오고, 자리만 밀린 이름은 나오지 않는다', () => {
    // 맨 위에 주석 두 줄을 더해 won, withVat, rounded의 줄이 모두 밀려요. withVat는 본문도 고쳐요.
    fx.write(
      'lib/core/money.dart',
      fx
        .read('lib/core/money.dart')
        .replace("String won", '// 금액 도우미\n// 두 줄 더함\nString won')
        .replace('amount ~/ 10', 'amount ~/ 5'),
    );
    const answer = fx.ask('detect_changes');
    assert.equal(answer.head.commit, null);
    assert.equal(answer.base.commit, fx.head());
    assert.deepEqual(changed(answer), ['modified lib/core/money.dart#withVat']);
    const withVat = answer.changes.items[0];
    assert.deepEqual([withVat.kind, withVat.line, withVat.module, withVat.role], ['function', 5, 'core', 'app']);
    // withVat ← Cart.total ← (checkoutLine, runApp, test main)
    assert.deepEqual(withVat.impact, { affected: 4, byDistance: { 1: 1, 2: 3 }, moreBeyondDepth: false, tests: 1 });
  });

  it('이름이 지워진 변경: 지운 이름이 나오고, 그 영향은 바꾸기 전에 그것을 쓰던 곳이다', () => {
    fx.write('lib/core/money.dart', fx.read('lib/core/money.dart').replace('\nint rounded(int amount) => amount - amount % 10;\n', ''));
    const answer = fx.ask('detect_changes');
    assert.deepEqual(changed(answer), ['removed lib/core/money.dart#rounded']);
    assert.equal(answer.changes.items[0].line, 8);
    // 바꾸기 전 커밋의 잠금 파일이 지금과 같아 패키지 설정을 빌려 정밀 색인했어요.
    assert.deepEqual([answer.changes.items[0].confidence, answer.changes.items[0].source], ['precise', 'scip-dart']);
    assert.deepEqual(
      answer.affected.items.map((a: any) => [a.distance, `${a.path}#${a.name}`, a.from, a.changed]),
      [
        [1, 'lib/features/shipping/shipping.dart#shippingFee', ['rounded'], false],
        [2, 'lib/app.dart#runApp', ['rounded'], false],
        [2, 'test/shipping_test.dart#main', ['rounded'], false],
      ],
    );
    assert.deepEqual(answer.summary.names, { added: 0, removed: 1, modified: 0, moved: 0 });
  });

  it('파일이 옮겨진 변경: 파일과 그 이름이 옮겨짐(moved)으로 나오고, 지우고 새로 만든 것으로 나오지 않는다', () => {
    fx.rename('lib/features/shipping/zones.dart', 'lib/core/zones.dart');
    fx.write('lib/features/shipping/shipping.dart', fx.read('lib/features/shipping/shipping.dart').replace("import 'zones.dart';", "import '../../core/zones.dart';"));
    const answer = fx.ask('detect_changes');
    assert.deepEqual(changed(answer), ['moved lib/core/zones.dart#lib/core/zones.dart', 'moved lib/core/zones.dart#zones']);
    for (const item of answer.changes.items) assert.equal(item.movedFrom, 'lib/features/shipping/zones.dart');
    assert.deepEqual([answer.changes.items[1].kind, answer.changes.items[1].module], ['constant', 'core']);
    assert.deepEqual(answer.summary.files, { added: 0, removed: 0, modified: 1, moved: 1 });
    // 옮긴 파일을 가져다 쓰는 곳과 옮긴 이름을 쓰는 곳. shipping.dart는 import를 고쳤으니 changed예요.
    assert.deepEqual(
      answer.affected.items.map((a: any) => [a.distance, `${a.path}#${a.name}`, a.changed]),
      [
        [1, 'lib/features/shipping/shipping.dart#lib/features/shipping/shipping.dart', true],
        [1, 'lib/features/shipping/shipping.dart#shippingFee', false],
        [2, 'lib/app.dart#lib/app.dart', false],
        [2, 'lib/app.dart#runApp', false],
        [2, 'test/shipping_test.dart#test/shipping_test.dart', false],
        [2, 'test/shipping_test.dart#main', false],
      ],
    );
  });

  /** core가 cart를 가져다 쓰게 하고(새 순환, 새 경계 위반), 그것을 쓰는 새 테스트 파일을 더해요(추적하지 않는 새 파일). */
  function coreUsesCart(): void {
    fx.write(
      'lib/core/money.dart',
      "import '../features/cart/cart.dart';\n\n" + fx.read('lib/core/money.dart') + '\nint cartVat(Cart cart) => withVat(cart.total());\n',
    );
    fx.write('test/money_test.dart', "import 'package:changes_sample/core/money.dart';\nimport 'package:changes_sample/features/cart/cart.dart';\n\nvoid main() {\n  assert(cartVat(Cart()) == 0);\n}\n");
  }

  it('변경이 닿는 모듈과 테스트 파일이 요약으로 나온다(고친 테스트 파일은 거리 0)', () => {
    coreUsesCart();
    const answer = fx.ask('detect_changes');
    assert.deepEqual(changed(answer), [
      'added lib/core/money.dart#cartVat',
      'added test/money_test.dart#test/money_test.dart',
      'added test/money_test.dart#main',
    ]);
    assert.deepEqual(answer.modules, [
      { module: null, changed: 2, affected: 1, tests: 1 },
      { module: 'core', changed: 1, affected: 0, tests: 0 },
    ]);
    assert.deepEqual(
      answer.tests.items.map((t: any) => [t.path, t.distance]),
      [['test/money_test.dart', 0]],
    );
    assert.deepEqual([answer.summary.modules, answer.summary.tests], [2, 1]);
  });

  it('이 변경으로 새로 생긴 순환과 경계 위반이 나오고, 이미 있던 것과 구분된다', () => {
    coreUsesCart();
    const { structure, summary } = fx.ask('detect_changes');
    assert.deepEqual(
      structure.cycles.introduced.items.map((c: any) => [c.status, c.files.items]),
      [['new', ['lib/core/money.dart', 'lib/features/cart/cart.dart']]],
    );
    // 이미 있던 receipt 묶음은 개수로만 나와요.
    assert.deepEqual([structure.cycles.existing, structure.cycles.resolved], [1, 0]);
    assert.deepEqual(
      structure.violations.introduced.items.map((v: any) => [v.from, v.to, v.fromModule, v.toModule, v.newImport]),
      [['lib/core/money.dart', 'lib/features/cart/cart.dart', 'core', 'cart', true]],
    );
    // 이미 있던 legacy.dart → receipt.dart는 개수로만 나와요.
    assert.deepEqual([structure.violations.existing, structure.violations.resolved], [1, 0]);
    assert.deepEqual([summary.newCycles, summary.newViolations], [1, 1]);
  });

  it('구조를 건드리지 않는 변경에는 새 순환과 경계 위반이 없다', () => {
    fx.write('lib/core/money.dart', fx.read('lib/core/money.dart').replace('amount ~/ 10', 'amount ~/ 5'));
    const { structure } = fx.ask('detect_changes');
    assert.deepEqual(
      [structure.cycles.introduced.total, structure.cycles.existing, structure.violations.introduced.total, structure.violations.existing],
      [0, 1, 0, 1],
    );
  });

  it('작업 트리가 색인보다 새로우면 다시 색인하고, 답의 항목마다 정밀/추정과 출처가 붙는다', () => {
    coreUsesCart();
    const status = fx.gitStatus();
    const answer = fx.ask('detect_changes');
    // 저장소(작업 트리와 staging)는 그대로예요.
    assert.equal(fx.gitStatus(), status);
    assert.equal(answer.reindexed, true);
    assert.equal(answer.index.stale, false);
    assert.deepEqual(unmarked(answer), []);
    // 고친 것이 없으면 다시 색인하지 않아요.
    assert.equal(fx.ask('detect_changes').reindexed, false);
  });

  it('목록은 limit으로 잘리고 전체 개수와 잘린 사실을 함께 낸다', () => {
    coreUsesCart();
    const answer = fx.ask('detect_changes', '--limit', '1');
    assert.deepEqual([answer.changes.total, answer.changes.truncated, answer.changes.items.length], [3, true, 1]);
    assert.deepEqual(answer.structure.cycles.introduced.items[0].files, { total: 2, truncated: true, items: ['lib/core/money.dart'] });
  });
});

describe('changes_sample detect_changes (커밋의 잠금 파일이 작업 트리와 다를 때)', () => {
  it('빌려 온 패키지 설정이 그 커밋에 맞는지 모르면(잠금 파일이 다름) 그 커밋 색인에서 온 항목은 추정이다', () => {
    // 커밋 색인마다 새로 만들게 홈을 따로 둬요(커밋 색인은 커밋마다 한 번 만들어 다시 써요).
    const home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    const fx = indexFixture('changes_sample', { home });
    try {
      // 작업 트리의 의존성을 바꾼 것처럼 잠금 파일을 고치고, 이름 하나를 지워요.
      fx.append('pubspec.lock', '# 의존성을 바꿈\n');
      fx.write('lib/core/money.dart', fx.read('lib/core/money.dart').replace('\nint rounded(int amount) => amount - amount % 10;\n', ''));
      const answer = fx.ask('detect_changes');
      assert.deepEqual(changed(answer), ['removed lib/core/money.dart#rounded']);
      // 지운 이름은 바꾸기 전(HEAD) 커밋 색인에서 와요. 그 커밋의 pubspec.lock이 작업 트리와 달라, 작업 트리에서 빌린
      // .dart_tool이 그 커밋에 맞는지 몰라요. scip-dart가 냈어도 추정이에요(열쇠는 정밀이라 짝짓기는 그대로예요).
      const removed = answer.changes.items[0];
      assert.deepEqual([removed.confidence, removed.source], ['inferred', 'scip-dart']);
      // 그것을 쓰던 곳(영향)도 바꾸기 전 커밋 색인에서 와서 추정이에요.
      assert.ok(answer.affected.total > 0);
      for (const a of answer.affected.items) assert.equal(a.confidence, 'inferred', `${a.path}#${a.name}`);
      assert.deepEqual(unmarked(answer), []);
    } finally {
      fx.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('changes_sample detect_changes (두 커밋 사이)', () => {
  let home: string;
  let fx: IndexedFixture;
  let mcp: McpSession;
  let first: string;
  let second: string;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('changes_sample', { home });
    first = fx.head();
    // 두 번째 커밋: withVat 본문을 고치고 rounded를 지워요. feature 브랜치에 두고 main은 첫 커밋으로 되돌려요.
    fx.write(
      'lib/core/money.dart',
      fx.read('lib/core/money.dart').replace('amount ~/ 10', 'amount ~/ 5').replace('\nint rounded(int amount) => amount - amount % 10;\n', ''),
    );
    second = fx.commit('withVat 고침, rounded 지움');
    fx.git('branch', 'feature');
    fx.git('reset', '--hard', '-q', first);
    mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
  });
  after(async () => {
    await mcp?.close();
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('두 커밋 사이로 물으면 그 사이의 변경이 나온다(작업 트리는 보지 않는다)', () => {
    fx.append('lib/core/money.dart', '\nint notCommitted() => 0;\n');
    try {
      const answer = fx.ask('detect_changes', '--base', first, '--head', second);
      assert.deepEqual(answer.base, { ref: first, commit: first });
      assert.deepEqual(answer.head, { ref: second, commit: second });
      assert.equal(answer.reindexed, false);
      assert.deepEqual(changed(answer), ['modified lib/core/money.dart#withVat', 'removed lib/core/money.dart#rounded']);
    } finally {
      fx.restore();
    }
  });

  it('브랜치 이름으로도 물을 수 있다', () => {
    const answer = fx.ask('detect_changes', '--base', 'main', '--head', 'feature');
    assert.deepEqual([answer.base.commit, answer.head.commit], [first, second]);
    assert.deepEqual(changed(answer), ['modified lib/core/money.dart#withVat', 'removed lib/core/money.dart#rounded']);
  });

  it('없는 커밋을 물으면 고칠 방법을 담은 오류다', async () => {
    const r = await mcp.callRaw('detect_changes', { base: 'no-such-branch' });
    assert.equal(r.isError, true);
    assert.match(r.text, /커밋을 찾지 못했어요: no-such-branch/);
  });

  it('MCP 도구로도 같은 답이 나온다', async () => {
    assert.ok((await mcp.tools()).includes('detect_changes'));
    assert.deepEqual(
      await mcp.call('detect_changes', { base: 'main', head: 'feature', depth: 1 }),
      fx.ask('detect_changes', '--base', 'main', '--head', 'feature', '--depth', '1'),
    );
  });
});
