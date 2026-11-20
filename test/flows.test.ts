// 실행 흐름(flows): 진입점에서 시작하는 호출 흐름이 뚜렷한 예제 저장소를 실제 scip-dart로 색인하고,
// 명령줄과 MCP의 flows 답을 정답과 비교해요. 추정 구간의 표시는 추정 층을 실제로 돌려(CODE_ATLAS_DISABLE_INDEXERS) 봐요.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expected, indexFixture, startMcp, type IndexedFixture } from './harness.ts';

/** 흐름 하나를 [진입점, 거치는 이름들]로 줄여 봐요. */
const flat = (flow: any): string[] => [flow.entry.name, ...flow.steps.items.map((s: any) => s.name)];

/**
 * 손으로 따라간 흐름(호출이 적힌 순서대로, 이미 나온 이름은 다시 펼치지 않음).
 * getter(roomName)와 모듈 수준 변수(greeting)는 읽기도 코드를 돌려서 흐름에 들고, 상수(refundFee)는 들지 않아요.
 */
const MAIN = ['main', 'pay', 'priceWithTax', 'roundUp', 'printReceipt', 'log', 'openChat', 'connect', 'roomName', 'sendHello', 'greeting', 'makeGreeting'];
const PAY = ['pay', 'priceWithTax', 'roundUp', 'printReceipt', 'log'];
const REFUND = ['refund', 'priceWithTax', 'roundUp', 'log'];
const PING = ['ping', 'pong'];

describe('flow_sample flows', () => {
  let home: string;
  let fx: IndexedFixture;
  let answer: any;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'code-atlas-home-'));
    fx = indexFixture('flow_sample', { home });
    answer = fx.ask('flows');
  });
  after(() => {
    fx?.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('진입점(불리지 않는 이름, 서로만 부르는 순환, 설정으로 지정한 것)마다 흐름 하나가 큰 것부터 나온다', () => {
    assert.equal(answer.flows.total, 4);
    assert.deepEqual(
      answer.flows.items.map((f: any) => [f.entry.name, f.reasons, f.size]),
      [
        ['main', ['uncalled'], 12],
        ['pay', ['config'], 5],
        ['refund', ['uncalled'], 4],
        ['ping', ['cycle'], 2],
      ],
    );
    assert.deepEqual(answer.summary, { entries: 4, uncalled: 2, cycles: 1, configured: 1, unmatched: [] });
  });

  it('테스트 코드의 호출은 셈하지 않는다(테스트만 부르는 refund는 진입점, 테스트의 main은 흐름이 아님)', () => {
    const entries = answer.flows.items.map((f: any) => f.entry);
    assert.deepEqual(
      entries.filter((e: any) => e.name === 'main').map((e: any) => e.path),
      ['lib/main.dart'],
    );
  });

  it('흐름마다 거치는 이름이 호출이 적힌 순서대로 나온다', () => {
    assert.deepEqual(answer.flows.items.map(flat), [MAIN, PAY, REFUND, PING]);
    const [main] = answer.flows.items;
    assert.deepEqual(
      main.steps.items.map((s: any) => [s.name, s.depth, s.from, s.relation]),
      [
        ['pay', 1, 'main', 'call'],
        ['priceWithTax', 2, 'pay', 'call'],
        ['roundUp', 3, 'priceWithTax', 'call'],
        ['printReceipt', 2, 'pay', 'call'],
        ['log', 3, 'printReceipt', 'call'],
        ['openChat', 1, 'main', 'call'],
        ['connect', 2, 'openChat', 'call'],
        ['roomName', 3, 'connect', 'read'],
        ['sendHello', 2, 'openChat', 'call'],
        ['greeting', 3, 'sendHello', 'read'],
        ['makeGreeting', 4, 'greeting', 'call'],
      ],
    );
    assert.deepEqual(main.steps.items[0].at, { path: 'lib/main.dart', line: 6, column: 3 });
    for (const flow of answer.flows.items) {
      assert.equal(flow.confidence, 'precise');
      assert.equal(flow.source, 'scip-dart');
      assert.equal(flow.beyondDepth, false);
    }
  });

  it('흐름 개수와 길이(깊이, 흐름마다 이름 수)를 제한할 수 있다', () => {
    const few = fx.ask('flows', '--limit', '2');
    assert.equal(few.flows.total, 4);
    assert.equal(few.flows.truncated, true);
    assert.deepEqual(few.flows.items.map((f: any) => f.entry.name), ['main', 'pay']);

    const short = fx.ask('flows', '--length', '3');
    const [main] = short.flows.items;
    assert.equal(main.size, 12);
    assert.deepEqual(main.steps.total, 11);
    assert.equal(main.steps.truncated, true);
    assert.deepEqual(flat(main), ['main', 'pay', 'priceWithTax', 'roundUp']);

    const shallow = fx.ask('flows', '--depth', '1');
    assert.deepEqual(
      shallow.flows.items.map((f: any) => [flat(f), f.beyondDepth]),
      [
        [['main', 'pay', 'openChat'], true],
        [['pay', 'priceWithTax', 'printReceipt'], true],
        [['refund', 'priceWithTax', 'log'], true],
        [['ping', 'pong'], false],
      ],
    );
  });

  it('이름 하나를 물으면 그 이름이 속한 묶음과 그 이름을 거치는 흐름이 나온다', () => {
    const log = fx.ask('flows', 'log');
    assert.equal(log.status, 'found');
    assert.equal(log.target.name, 'log');
    assert.deepEqual(log.flows.items.map((f: any) => [f.entry.name, f.hits]), [
      ['main', ['log']],
      ['pay', ['log']],
      ['refund', ['log']],
    ]);
    // 묶음은 clusters가 내는 묶음 그대로예요.
    const all = fx.ask('clusters');
    const mine = all.clusters.items.filter((c: any) => c.names.items.includes('log'));
    assert.equal(mine.length, 1);
    assert.deepEqual(log.clusters, { total: 1, truncated: false, items: mine });

    // 진입점 자신을 물어도 그 흐름에 들어요.
    const ping = fx.ask('flows', 'ping');
    assert.deepEqual(ping.flows.items.map((f: any) => [f.entry.name, f.hits]), [['ping', ['ping']]]);
  });

  it('없는 이름이면 없다고 답한다', () => {
    const none = fx.ask('flows', 'nope');
    assert.equal(none.status, 'not_found');
    assert.equal(none.flows, undefined);
  });

  it('설정에 진입점을 적었는데 맞는 이름이 없으면 알려 준다', () => {
    fx.write('other.json', JSON.stringify({ flows: { entries: [{ name: 'pay' }, { name: '*.build' }], uncalled: false } }));
    const answer = fx.ask('flows', '--config', join(fx.repo, 'other.json'));
    assert.deepEqual(answer.flows.items.map((f: any) => f.entry.name), ['pay']);
    assert.deepEqual(answer.summary, { entries: 1, uncalled: 0, cycles: 0, configured: 1, unmatched: ['*.build'] });
    fx.restore();
  });

  it('답 전체가 정답과 같고, 다시 물어도 처음부터 다시 색인해도 같다', () => {
    const want = expected('flow_sample', 'flows.json');
    const { index, ...rest } = answer;
    assert.deepEqual(rest, want);
    const { index: _a, ...again } = fx.ask('flows');
    assert.deepEqual(again, want);
    const { index: _b, ...fresh } = fx.indexFresh().ask('flows');
    assert.deepEqual(fresh, want);
  });

  it('MCP 도구로도 같은 답이 나온다', async () => {
    const mcp = await startMcp({ cwd: fx.repo, env: { CODE_ATLAS_HOME: home } });
    try {
      assert.ok((await mcp.tools()).includes('flows'));
      const { index, ...viaMcp } = await mcp.call('flows', { repo: fx.repo });
      assert.deepEqual(viaMcp, expected('flow_sample', 'flows.json'));
      const { index: _i, ...byName } = await mcp.call('flows', { name: 'log' });
      const { index: _j, ...cli } = fx.ask('flows', 'log');
      assert.deepEqual(byName, cli);
    } finally {
      await mcp.close();
    }
  });
});

describe('추정 구간의 표시(추정 층을 실제로 돌려요)', () => {
  it('정밀 색인기가 없으면 같은 흐름이 나오고(추정 층이 놓치는 것 빼고), 구간마다 추정 표시가 붙는다', () => {
    const fx = indexFixture('flow_sample', { env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-dart' } });
    try {
      assert.deepEqual(fx.firstSummary.adapters, ['tree-sitter-dart']);
      const answer = fx.ask('flows');
      // 추정 층은 글 끼워 넣기의 `$roomName`(중괄호 없음)을 놓쳐요(architecture.md "추정 층이 놓치는 것 (Dart)").
      const inferredMain = MAIN.filter((n) => n !== 'roomName');
      assert.deepEqual(answer.flows.items.map(flat), [inferredMain, PAY, REFUND, PING]);
      for (const flow of answer.flows.items) {
        assert.deepEqual([flow.confidence, flow.source], ['inferred', 'tree-sitter-dart']);
        for (const s of flow.steps.items) assert.deepEqual([s.confidence, s.source], ['inferred', 'tree-sitter-dart']);
      }
    } finally {
      fx.dispose();
    }
  });

  it('정밀 구간과 추정 구간이 섞인 흐름은 추정 구간에만 표시가 붙고, 흐름 전체는 추정이다', () => {
    const fx = indexFixture('mixed_sample', { pubGetIn: ['app'] });
    try {
      const answer = fx.ask('flows');
      const main = answer.flows.items.find((f: any) => f.entry.name === 'main');
      assert.deepEqual(main.reasons, ['uncalled']);
      // scripts/report.dart(추정 층)의 main → buildReport → Cart()와 Cart.total → app/(scip-dart)의 withVat.
      assert.deepEqual(
        main.steps.items.map((s: any) => [s.from, s.name, s.confidence, s.source]),
        [
          ['main', 'buildReport', 'inferred', 'tree-sitter-dart'],
          ['buildReport', 'Cart', 'inferred', 'tree-sitter-dart'],
          ['buildReport', 'Cart.total', 'inferred', 'tree-sitter-dart'],
          ['Cart.total', 'withVat', 'precise', 'scip-dart'],
        ],
      );
      assert.equal(main.confidence, 'inferred');
      assert.equal(main.source, 'scip-dart,tree-sitter-dart');
    } finally {
      fx.dispose();
    }
  });
});
