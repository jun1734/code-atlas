// 이름 바꾸기 계획(rename): 예제 저장소를 색인하고 명령줄·MCP로 계획을 물어, 고칠 자리를 정답과 비교해요.
// 도구는 파일을 고치지 않아요. 계획대로 고치는 것은 테스트(부르는 쪽)가 저장소 밖 사본에서 해요.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { indexFixture, startMcp, type IndexedFixture } from './harness.ts';

/** 고칠 자리 하나를 [경로, 줄, 열, 종류]로 줄여 봐요. */
const sites = (page: any): [string, number, number, string][] => page.items.map((s: any) => [s.path, s.line, s.column, s.kind]);

/** 폴더 안 파일 전부의 내용(.git 빼고). 도구가 파일을 고치지 않았는지 바이트 단위로 비교해요. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (path === '.git' || path.startsWith('.git/')) continue;
    out.set(path, readFileSync(join(dir, path)));
  }
  return out;
}

/**
 * 부르는 쪽이 하듯 계획(edits, inferred, unlinked)을 저장소 사본에 적용해요. 자리는 모두 원래 글 기준이라
 * 한 줄 안에서는 뒤의 자리부터 바꿔요. 여러 계획을 함께 적용해도 자리가 겹치지 않으면 돼요.
 */
function applyPlans(dir: string, plans: any[]): void {
  const byFile = new Map<string, any[]>();
  for (const plan of plans) {
    assert.equal(plan.edits.truncated || plan.inferred.truncated || plan.unlinked.truncated, false);
    for (const s of [...plan.edits.items, ...plan.inferred.items, ...plan.unlinked.items]) {
      if (!byFile.has(s.path)) byFile.set(s.path, []);
      byFile.get(s.path)!.push(s);
    }
  }
  for (const [path, list] of byFile) {
    const lines = readFileSync(join(dir, path), 'utf8').split('\n');
    list.sort((a, b) => b.line - a.line || b.column - a.column);
    for (const s of list) {
      const text = lines[s.line - 1]!;
      assert.equal(text.slice(s.column - 1, s.endColumn - 1), s.oldText, `${path}:${s.line}:${s.column}`);
      lines[s.line - 1] = text.slice(0, s.column - 1) + s.newText + text.slice(s.endColumn - 1);
    }
    writeFileSync(join(dir, path), lines.join('\n'));
  }
}

describe('rename_sample rename (scip-dart)', () => {
  let home: string;
  let fx: IndexedFixture;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('rename_sample', { home });
  });
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('이름과 새 이름을 주면 고칠 자리(파일, 줄, 칸) 전체가 계획으로 나온다: show 조합자, 글 사이에 끼운 이름 포함', () => {
    const plan = fx.ask('rename', 'withTax', '--to', 'addTax');
    assert.equal(plan.status, 'found');
    assert.equal(plan.newName, 'addTax');
    assert.deepEqual(sites(plan.edits), [
      ['bin/main.dart', 1, 72, 'read'],
      ['bin/main.dart', 6, 14, 'read'],
      ['bin/main.dart', 6, 24, 'call'],
      ['lib/rename_sample.dart', 3, 37, 'read'],
      ['lib/src/account.dart', 7, 37, 'call'],
      ['lib/src/account.dart', 10, 60, 'call'],
      ['lib/src/money.dart', 2, 5, 'definition'],
      ['lib/src/money.dart', 23, 20, 'call'],
      ['test/money_test.dart', 6, 7, 'call'],
    ]);
    assert.deepEqual(plan.edits.items[0], {
      path: 'bin/main.dart',
      line: 1,
      column: 72,
      endColumn: 79,
      oldText: 'withTax',
      newText: 'addTax',
      kind: 'read',
      role: 'app',
      confidence: 'precise',
      source: 'scip-dart',
    });
    assert.equal(plan.edits.total, 9);
    assert.equal(plan.inferred.total, 0);
  });

  it('클래스: 이름 있는 생성자의 클래스 이름은 고칠 자리, 색인이 클래스로 합친 이름 없는 생성자의 선언은 따로 unlinked로 나온다', () => {
    const plan = fx.ask('rename', 'Money', '--to', 'Cash');
    assert.equal(plan.status, 'found');
    assert.deepEqual(sites(plan.edits), [
      ['bin/main.dart', 1, 65, 'reference'],
      ['bin/main.dart', 5, 17, 'call'],
      ['lib/rename_sample.dart', 3, 30, 'reference'],
      ['lib/src/account.dart', 4, 9, 'reference'],
      ['lib/src/account.dart', 4, 25, 'reference'],
      ['lib/src/money.dart', 12, 7, 'definition'],
      ['lib/src/money.dart', 17, 3, 'reference'],
      ['test/money_test.dart', 4, 17, 'reference'],
    ]);
    // 추정 층이 이은 자리는 없어요. 구문으로만 찾은 자리는 inferred가 아니라 unlinked에 따로 나와요.
    assert.equal(plan.inferred.total, 0);
    // 글(문자열) 'Money($cents, …)' 안의 Money는 이름이 아니라서 나오지 않아요.
    assert.deepEqual(plan.unlinked.items, [
      {
        path: 'lib/src/money.dart',
        line: 15,
        column: 3,
        endColumn: 8,
        oldText: 'Money',
        newText: 'Cash',
        kind: 'unlinked',
        role: 'app',
        in: 'Money',
        confidence: 'inferred',
        source: 'tree-sitter-dart',
      },
    ]);
    assert.deepEqual(plan.warnings.items, []);
  });

  it('getter와 setter: 짝 하나로 바뀌고, 색인이 getter로 합친 setter 선언은 따로 unlinked로 나온다', () => {
    const plan = fx.ask('rename', 'Money.cents', '--to', 'amount');
    assert.equal(plan.status, 'found');
    assert.deepEqual(sites(plan.edits), [
      ['bin/main.dart', 6, 38, 'read'],
      ['lib/src/account.dart', 7, 13, 'write'],
      ['lib/src/account.dart', 7, 29, 'read'],
      ['lib/src/account.dart', 15, 15, 'write'],
      ['lib/src/money.dart', 19, 11, 'definition'],
      ['lib/src/money.dart', 23, 28, 'read'],
      ['lib/src/money.dart', 26, 32, 'read'],
      ['test/money_test.dart', 4, 31, 'write'],
      ['test/money_test.dart', 5, 13, 'read'],
    ]);
    assert.equal(plan.inferred.total, 0);
    assert.deepEqual(sites(plan.unlinked), [['lib/src/money.dart', 21, 7, 'unlinked']]);
    assert.deepEqual(plan.summary, { files: 4, edits: 9, inferred: 0, unlinked: 1, warnings: 0 });
  });

  it('새 이름이 같은 범위의 다른 이름과 겹치면 경고가 나온다: 같은 파일의 최상위 이름, 같은 타입의 멤버', () => {
    const top = fx.ask('rename', 'withTax', '--to', 'roundUp');
    assert.deepEqual(
      top.warnings.items.map((w: any) => [w.kind, w.name, w.path, w.line, w.column, w.confidence, w.source]),
      [['conflict', 'roundUp', 'lib/src/money.dart', 5, 5, 'precise', 'scip-dart']],
    );
    const member = fx.ask('rename', 'Money.cents', '--to', 'taxed');
    assert.deepEqual(
      member.warnings.items.map((w: any) => [w.kind, w.name, w.path, w.line]),
      [['conflict', 'Money.taxed', 'lib/src/money.dart', 23]],
    );
    // 고칠 파일이 이미 쓰는 다른 파일의 최상위 이름과도 겹쳐요(account.dart가 withTax를 써요).
    const used = fx.ask('rename', 'resetAll', '--to', 'withTax');
    assert.deepEqual(
      used.warnings.items.map((w: any) => [w.kind, w.name, w.path, w.line]),
      [['conflict', 'withTax', 'lib/src/money.dart', 2]],
    );
    // 겹치지 않는 새 이름이면 경고가 없어요.
    assert.equal(fx.ask('rename', 'withTax', '--to', 'addTax').warnings.total, 0);
  });

  it('상속·구현으로 이어진 타입의 같은 이름 멤버는 재정의가 끊긴다는 경고(override)로, 그 멤버와 겹치면 conflict로 나온다', () => {
    const plan = fx.ask('rename', 'Money.describe', '--to', 'show');
    assert.deepEqual(
      plan.warnings.items.map((w: any) => [w.kind, w.name, w.path, w.line]),
      [['override', 'Describable.describe', 'lib/src/money.dart', 9]],
    );
    const clash = fx.ask('rename', 'Money.taxed', '--to', 'describe');
    assert.deepEqual(
      clash.warnings.items.map((w: any) => [w.kind, w.name, w.line]),
      [
        ['conflict', 'Describable.describe', 9],
        ['conflict', 'Money.describe', 26],
      ],
    );
  });

  it('같은 이름이 여럿이면 고르지 않고 후보를 돌려준다', () => {
    const plan = fx.ask('rename', 'main', '--to', 'run');
    assert.equal(plan.status, 'ambiguous');
    assert.deepEqual(
      plan.candidates.map((c: any) => c.definition.path),
      ['bin/main.dart', 'test/money_test.dart'],
    );
    assert.equal(plan.edits, undefined);
  });

  it('새 이름이 식별자 하나가 아니거나 지금 이름과 같으면 답 대신 고칠 방법을 담은 오류가 난다', () => {
    assert.throws(() => fx.ask('rename', 'Money.cents', '--to', 'Money.amount'), /식별자 하나/);
    assert.throws(() => fx.ask('rename', 'withTax', '--to', 'withTax'), /지금 이름과 같아요/);
    assert.throws(() => fx.ask('rename', 'lib/src/money.dart', '--to', 'cash'), /파일 이름 바꾸기/);
  });

  it('도구는 파일을 고치지 않는다: 계획을 물은 뒤에도 저장소의 파일이 바이트 단위로 그대로다', () => {
    const before = snapshot(fx.repo);
    fx.ask('rename', 'withTax', '--to', 'addTax');
    fx.ask('rename', 'Money', '--to', 'Cash');
    fx.ask('rename', 'Money.cents', '--to', 'amount');
    assert.deepEqual(snapshot(fx.repo), before);
    assert.equal(fx.gitStatus(), '');
  });

  it('계획대로 고친 예제 저장소가 dart analyze를 통과한다(저장소 밖 사본에서 부르는 쪽이 고쳐요)', () => {
    const plans = [
      fx.ask('rename', 'withTax', '--to', 'addTax'),
      fx.ask('rename', 'Money', '--to', 'Cash'),
      fx.ask('rename', 'Money.cents', '--to', 'amount'),
    ];
    const work = mkdtempSync(join(tmpdir(), 'code-atlas-rename-'));
    try {
      const copy = join(work, 'rename_sample');
      cpSync(fx.repo, copy, { recursive: true, filter: (src) => !src.includes(`${join(fx.repo, '.git')}`) });
      applyPlans(copy, plans);
      const money = readFileSync(join(copy, 'lib/src/money.dart'), 'utf8');
      assert.match(money, /^ {2}Cash\(this\._cents\);$/m);
      assert.match(money, /^ {2}set amount\(int value\)/m);
      // 글(문자열) 안의 이름은 그대로예요.
      assert.match(money, /'Money\(\$amount, \$taxed\)'/);
      // 바꾸기 전 이름이 남아 있으면 analyze가 실패해요. 남지 않았는지는 analyze가 봐요.
      const out = execSync('dart analyze --fatal-infos', { cwd: copy, encoding: 'utf8' });
      assert.match(out, /No issues found/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('MCP 도구 rename이 명령줄과 같은 계획을 돌려준다', async () => {
    const mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
    try {
      assert.ok((await mcp.tools()).includes('rename'));
      const viaMcp = await mcp.call('rename', { query: 'Money.cents', to: 'amount' });
      const viaCli = fx.ask('rename', 'Money.cents', '--to', 'amount');
      assert.deepEqual({ ...viaMcp, index: undefined }, { ...viaCli, index: undefined });
    } finally {
      await mcp.close();
    }
  });
});

describe('추정 층이 찾은 자리는 계획에서 따로 나온다', () => {
  it('정밀 층과 추정 층이 섞인 저장소(mixed_sample): 패키지 안은 edits, 패키지 밖 스크립트의 사용처는 inferred', () => {
    const fx = indexFixture('mixed_sample', { pubGetIn: ['app'] });
    try {
      const plan = fx.ask('rename', 'Cart', '--to', 'Basket');
      assert.equal(plan.status, 'found');
      assert.deepEqual(
        plan.edits.items.map((s: any) => [s.path, s.line, s.column, s.kind, s.confidence, s.source]),
        [['app/lib/cart.dart', 3, 7, 'definition', 'precise', 'scip-dart']],
      );
      assert.deepEqual(
        plan.inferred.items.map((s: any) => [s.path, s.line, s.column, s.kind, s.in, s.confidence, s.source]),
        [['scripts/report.dart', 5, 16, 'call', 'buildReport', 'inferred', 'tree-sitter-dart']],
      );
    } finally {
      fx.dispose();
    }
  });

  it('정밀 색인기가 없을 때(rename_sample, scip-dart 없음): 모든 자리가 inferred에 나오고 edits는 비어 있다', () => {
    const fx = indexFixture('rename_sample', { env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-dart' } });
    try {
      const plan = fx.ask('rename', 'withTax', '--to', 'addTax');
      assert.equal(plan.edits.total, 0);
      // 추정 층은 show 조합자와 글에 끼운 함수 값($withTax)을 잇지 못해요(docs/architecture.md "추정 층이 놓치는 것").
      assert.deepEqual(sites(plan.inferred), [
        ['bin/main.dart', 6, 24, 'call'],
        ['lib/src/account.dart', 7, 37, 'call'],
        ['lib/src/account.dart', 10, 60, 'call'],
        ['lib/src/money.dart', 2, 5, 'definition'],
        ['lib/src/money.dart', 23, 20, 'call'],
        ['test/money_test.dart', 6, 7, 'call'],
      ]);
      for (const s of plan.inferred.items) assert.deepEqual([s.confidence, s.source], ['inferred', 'tree-sitter-dart']);

      // 추정 층은 getter와 setter를 따로 적어요. 같은 자리의 접근자 짝이라 모호하지 않고 둘 다 바꿔요.
      const pair = fx.ask('rename', 'Money.cents', '--to', 'amount');
      assert.equal(pair.status, 'found');
      assert.deepEqual(pair.targets.map((t: any) => t.kind), ['getter', 'setter']);
      assert.equal(pair.edits.total, 0);
      // 추정 층이 이은 자리(inferred)와, 추정 층도 잇지 못해 구문으로만 찾은 자리(unlinked)는 따로 나와요.
      assert.deepEqual(sites(pair.inferred), [
        ['lib/src/money.dart', 19, 11, 'definition'],
        ['lib/src/money.dart', 21, 7, 'definition'],
      ]);
      assert.deepEqual(sites(pair.unlinked), [
        ['lib/src/money.dart', 23, 28, 'unlinked'],
        ['lib/src/money.dart', 26, 32, 'unlinked'],
      ]);
    } finally {
      fx.dispose();
    }
  });
});
