// 두 지점 사이 경로(trace): 길이 여럿인 예제 저장소를 실제 scip-dart로 색인하고, 명령줄과 MCP의 trace 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, startMcp, type IndexedFixture } from './harness.ts';

/** 경로 하나를 지나는 이름들로 줄여 봐요. */
const names = (path: any): string[] => path.nodes.map((n: any) => n.name);

describe('trace_sample trace', () => {
  let home: string;
  let fx: IndexedFixture;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('trace_sample', { home });
  });
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('두 이름 사이의 가장 짧은 경로가 먼저 나오고, 다른 경로도 짧은 순으로 나온다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'writeRow');
    assert.equal(answer.status, 'found');
    assert.equal(answer.paths.total, 3);
    assert.equal(answer.paths.truncated, false);
    assert.deepEqual(answer.paths.items.map(names), [
      ['OrderButton.onPressed', 'OrderService.quickOrder', 'writeRow'],
      ['OrderButton.onPressed', 'OrderService.placeOrder', 'OrderRepository.save', 'writeRow'],
      ['OrderButton.onPressed', 'OrderService.placeOrder', 'OrderService.validate', 'logAudit', 'writeRow'],
    ]);
    assert.deepEqual(answer.paths.items.map((p: any) => p.length), [2, 3, 4]);
  });

  it('경로의 구간마다 관계 종류와 적힌 자리가 붙는다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'writeRow');
    assert.deepEqual(answer.paths.items[0].steps, [
      {
        from: 'OrderButton.onPressed',
        to: 'OrderService.quickOrder',
        kind: 'call',
        at: { path: 'lib/ui/order_button.dart', line: 11, column: 13 },
        confidence: 'precise',
        kindConfidence: 'inferred',
        source: 'scip-dart',
      },
      {
        from: 'OrderService.quickOrder',
        to: 'writeRow',
        kind: 'call',
        at: { path: 'lib/app/order_service.dart', line: 15, column: 30 },
        confidence: 'precise',
        kindConfidence: 'inferred',
        source: 'scip-dart',
      },
    ]);
  });

  it('개수 제한 안에서 자르고 전체 개수와 잘린 사실을 함께 낸다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'writeRow', '--limit', '2');
    assert.equal(answer.paths.total, 3);
    assert.equal(answer.paths.truncated, true);
    assert.equal(answer.paths.items.length, 2);
  });

  it('두 파일 사이의 경로도 나온다(파일의 import와 그 파일이 정의한 이름에서 출발한다)', () => {
    const answer = fx.ask('trace', 'lib/ui/order_summary.dart', '--to', 'lib/data/order.dart', '--follow', 'all');
    assert.equal(answer.status, 'found');
    assert.deepEqual(answer.from, { name: 'lib/ui/order_summary.dart', kind: 'file', path: 'lib/ui/order_summary.dart' });
    // 같은 길이면 지나는 노드 id 순이라 파일(f:)이 심볼(s:)보다 앞에 와요.
    assert.deepEqual(answer.paths.items.map(names), [
      ['lib/ui/order_summary.dart', 'lib/data/order.dart'],
      ['describe', 'Order'],
      ['describe', 'Order.id'],
    ]);
    assert.deepEqual(
      answer.paths.items.map((p: any) => [p.steps[0].kind, p.steps[0].kindConfidence]),
      [
        ['import', 'precise'],
        ['reference', 'inferred'],
        ['read', 'inferred'],
      ],
    );
  });

  it('경로가 없으면 없다고 답하고, 거꾸로는 이어지는지 알려 준다', () => {
    const none = fx.ask('trace', 'OrderButton', '--to', 'clearCache');
    assert.equal(none.status, 'no_path');
    assert.deepEqual(none.paths, { total: 0, truncated: false, items: [], capped: false });
    assert.equal(none.reverse, false);

    const backwards = fx.ask('trace', 'writeRow', '--to', 'OrderButton');
    assert.equal(backwards.status, 'no_path');
    assert.equal(backwards.reverse, true);
  });

  it('depth보다 긴 경로만 있으면 없다고 답하고, 가장 짧은 경로의 길이를 알려 준다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'logAudit', '--depth', '2');
    assert.equal(answer.status, 'no_path');
    assert.equal(answer.shortestBeyondDepth, 3);
    const deeper = fx.ask('trace', 'OrderButton', '--to', 'logAudit', '--depth', '3');
    assert.deepEqual(deeper.paths.items.map(names), [
      ['OrderButton.onPressed', 'OrderService.placeOrder', 'OrderService.validate', 'logAudit'],
    ]);
  });

  it('호출만 따라갈지, 참조와 import도 따라갈지 고른다(기본은 호출만)', () => {
    const calls = fx.ask('trace', 'describe', '--to', 'Order');
    assert.equal(calls.follow, 'calls');
    assert.equal(calls.status, 'no_path');
    const all = fx.ask('trace', 'describe', '--to', 'Order', '--follow', 'all');
    assert.equal(all.follow, 'all');
    assert.deepEqual(all.paths.items.map(names), [
      ['describe', 'Order'],
      ['describe', 'Order.id'],
    ]);
  });

  it('follow에 모르는 값을 주면 답 대신 고칠 방법을 알려 준다', () => {
    assert.throws(() => fx.ask('trace', 'OrderButton', '--to', 'writeRow', '--follow', 'refs'), /follow는 calls 또는 all/);
  });

  it('추정 관계를 거친 경로에는 표시가 붙는다(구간의 가장 낮은 믿음이 경로의 믿음)', () => {
    const calls = fx.ask('trace', 'OrderButton', '--to', 'writeRow');
    for (const p of calls.paths.items) {
      assert.equal(p.confidence, 'precise');
      assert.equal(p.kindConfidence, 'inferred');
      assert.equal(p.source, 'scip-dart');
    }
    const files = fx.ask('trace', 'lib/ui/order_summary.dart', '--to', 'lib/data/order.dart', '--follow', 'all');
    const importPath = files.paths.items.find((p: any) => p.steps[0].kind === 'import');
    assert.equal(importPath.kindConfidence, 'precise');
  });

  it('이름이 여럿에 맞으면 고르지 않고 그쪽 후보를 돌려준다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'save');
    assert.equal(answer.status, 'ambiguous');
    assert.equal(answer.candidates.from, undefined);
    assert.deepEqual(
      answer.candidates.to.map((c: any) => c.qualifiedName),
      ['Draft.save', 'OrderRepository.save'],
    );
    const picked = fx.ask('trace', 'OrderButton', '--to', 'OrderRepository.save');
    assert.equal(picked.status, 'found');
  });

  it('없는 이름이면 어느 쪽이 없는지 알려 준다', () => {
    const answer = fx.ask('trace', 'OrderButton', '--to', 'nope');
    assert.equal(answer.status, 'not_found');
    assert.deepEqual(answer.notFound, ['to']);
  });

  it('같은 질문은 늘 같은 답이고, 답 전체가 정답과 같다(import 경로와 호출 경로가 길이 순으로 섞인다)', () => {
    const q = ['trace', 'lib/ui/order_button.dart', '--to', 'lib/data/db.dart', '--follow', 'all'];
    const a = fx.ask(...q);
    const b = fx.ask(...q);
    assert.deepEqual(a, b);
    const { index, ...rest } = a;
    assert.deepEqual(rest, expected('trace_sample', 'trace-all.json'));
  });

  it('MCP 도구로도 같은 답이 나온다', async () => {
    const mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
    try {
      assert.ok((await mcp.tools()).includes('trace'));
      const cli = fx.ask('trace', 'OrderButton', '--to', 'writeRow');
      const viaMcp = await mcp.call('trace', { from: 'OrderButton', to: 'writeRow' });
      assert.equal(viaMcp.status, 'found');
      assert.deepEqual(viaMcp.paths, cli.paths);
    } finally {
      await mcp.close();
    }
  });
});
