// 묶음(clusters): 두 덩어리가 뚜렷한 예제 저장소를 실제 scip-dart로 색인하고, 명령줄과 MCP의 clusters 답을 정답과 비교해요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, startMcp, type IndexedFixture } from './harness.ts';

describe('cluster_sample clusters', () => {
  let home: string;
  let fx: IndexedFixture;
  let answer: any;
  const want = expected('cluster_sample', 'clusters.json');
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('cluster_sample', { home });
    answer = fx.ask('clusters');
  });
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('두 덩어리가 뚜렷이 나뉜 저장소에서 두 묶음이 나온다', () => {
    assert.equal(answer.clusters.total, 2);
    assert.deepEqual(
      answer.clusters.items.map((c: any) => c.names.items),
      [
        ['Invoice', 'LineItem', 'formatReceipt', 'lineTax', 'taxRate', 'withTax'],
        ['Message', 'Room', 'Sender'],
      ],
    );
  });

  it('묶음마다 든 이름과 파일, 대표 이름이 나온다', () => {
    const [billing, chat] = answer.clusters.items;
    assert.deepEqual(billing.files.items, [
      'lib/billing/invoice.dart',
      'lib/billing/line_item.dart',
      'lib/billing/tax.dart',
      'lib/misc/receipt_format.dart',
    ]);
    assert.deepEqual(chat.files.items, ['lib/chat/message.dart', 'lib/chat/room.dart', 'lib/chat/sender.dart']);
    assert.equal(billing.representative.name, 'formatReceipt'); // 손으로 센 묶음 안 관계: formatReceipt 9, Invoice 8
    assert.equal(billing.representative.definition.path, 'lib/misc/receipt_format.dart');
    assert.equal(chat.representative.name, 'Message'); // Message 8, Room 6, Sender 6
  });

  it('묶음이 여러 모듈에 걸쳐 있으면 그 사실이 나온다', () => {
    const [billing, chat] = answer.clusters.items;
    assert.deepEqual(billing.modules, ['billing', 'misc']);
    assert.equal(billing.crossModule, true);
    assert.deepEqual(chat.modules, ['chat']);
    assert.equal(chat.crossModule, false);
  });

  it('답 전체가 정답과 같다', () => {
    const { index, ...rest } = answer;
    assert.deepEqual(rest, want);
  });

  it('같은 색인에 다시 돌려도, 처음부터 다시 색인해도 같은 묶음이 나온다', () => {
    const { index: _a, ...again } = fx.ask('clusters');
    assert.deepEqual(again, want);
    const { index: _b, ...fresh } = fx.indexFresh().ask('clusters');
    assert.deepEqual(fresh, want);
  });

  it('목록은 limit으로 잘리고, MCP 도구도 같은 답을 낸다', async () => {
    const cut = fx.ask('clusters', '--limit', '1');
    assert.equal(cut.clusters.total, 2);
    assert.equal(cut.clusters.truncated, true);
    assert.equal(cut.clusters.items.length, 1);
    // 묶음 안의 목록(이름, 파일)도 같은 limit으로 잘려요.
    assert.deepEqual(cut.clusters.items[0].names, { total: 6, truncated: true, items: ['Invoice'] });
    assert.deepEqual(cut.clusters.items[0].files, { total: 4, truncated: true, items: ['lib/billing/invoice.dart'] });
    const mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
    try {
      assert.ok((await mcp.tools()).includes('clusters'));
      const { index, ...viaMcp } = await mcp.call('clusters', { repo: fx.repo });
      assert.equal(index.repo, fx.repo);
      assert.deepEqual(viaMcp, want);
    } finally {
      await mcp.close();
    }
  });
});
