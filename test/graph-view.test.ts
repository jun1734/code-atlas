// 이름 단위 그래프 화면: 예제 저장소를 색인하고 명령줄 `map`이 함께 그린 그래프 HTML의 자료가
// 같은 저장소에 명령줄로 물은 search·context·impact의 답과 같은지 봐요. 화면의 생김새는 브라우저로 띄워 확인해요.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { indexFixture, runCliRaw, type IndexedFixture } from './harness.ts';

const DATA = (id: string) => new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`);

function dataOf(html: string, id: string): any {
  const m = DATA(id).exec(html);
  assert.ok(m, `HTML에 ${id} 자료가 있어야 해요`);
  return JSON.parse(m[1]!);
}

/** 그래프 자료를 읽는 법(화면이 읽는 것과 같은 꼴). 칸의 뜻은 src/map/graph-data.ts에 있어요. */
function reader(D: any) {
  const conf = (i: number) => (i ? 'inferred' : 'precise');
  const nodeOf = (q: string) => {
    const found = D.nodes.filter((n: any) => n.k === q || n.q === q || (n.d === 'file' && D.paths[n.p] === q));
    assert.equal(found.length, 1, `그래프 자료에 ${q} 노드가 하나 있어야 해요`);
    return found[0];
  };
  const uses = (n: any) => ({
    total: n.U[0],
    items: n.U[1].map(([p, line, column, kind, kindInf, inf, s, test, inside]: any[]) => ({
      path: D.paths[p],
      line,
      column,
      role: test ? 'test' : 'app',
      kind,
      kindConfidence: conf(kindInf),
      ...(inside !== undefined ? { in: inside } : {}),
      confidence: conf(inf),
      source: D.sources[s],
    })),
  });
  const affected = (n: any) => ({
    total: n.A[0],
    more: n.A[1] === 1,
    items: n.A[2].map(([to, distance, via, relation, inf, s]: any[]) => ({
      name: D.nodes[to].q,
      path: D.paths[D.nodes[to].p],
      distance,
      via: via < 0 ? null : D.nodes[via].q,
      relation,
      confidence: conf(inf),
      source: D.sources[s],
    })),
  });
  return { nodeOf, uses, affected, conf };
}

/** impact 답의 영향 받는 곳을 그래프 자료와 비교할 꼴로. */
const impactItems = (answer: any) =>
  answer.affected.items.map((i: any) => ({
    name: i.name,
    path: i.path,
    distance: i.distance,
    relation: i.via.relation,
    confidence: i.confidence,
    source: i.source,
  }));

for (const layer of [
  { name: '정밀 층', env: {} as Record<string, string>, confidence: 'precise' },
  { name: '추정 층(CODE_ATLAS_DISABLE_INDEXERS=scip-dart)', env: { CODE_ATLAS_DISABLE_INDEXERS: 'scip-dart' }, confidence: 'inferred' },
]) {
  describe(`impact_sample 그래프 화면, ${layer.name}`, () => {
    let fx: IndexedFixture;
    let work: string;
    let printed: any;
    let D: any;
    let M: any;
    let R: ReturnType<typeof reader>;
    before(() => {
      fx = indexFixture('impact_sample', { env: layer.env });
      work = mkdtempSync(join(tmpdir(), 'code-atlas-graph-'));
      const db = join(fx.repo, '..', 'atlas.db');
      const r = runCliRaw(['map', '--repo', fx.repo, '--db', db, '--out', join(work, 'map.html')], layer.env);
      assert.equal(r.status, 0, r.stderr);
      printed = JSON.parse(r.stdout);
      D = dataOf(readFileSync(printed.graph, 'utf8'), 'symbol-graph-data');
      M = dataOf(readFileSync(printed.out, 'utf8'), 'code-map-data');
      R = reader(D);
    });
    after(() => {
      fx?.dispose();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('map 명령이 코드 지도 옆에 그래프 화면을 그리고, 두 화면이 서로의 파일 이름을 안다', () => {
      assert.equal(dirname(printed.graph), work);
      assert.equal(basename(printed.graph), 'map-graph.html');
      assert.equal(M.graph, 'map-graph.html');
      assert.equal(D.map, 'map.html');
      assert.equal(D.commit, fx.head());
      assert.equal(D.branch, 'main');
      assert.match(readFileSync(printed.graph, 'utf8'), /^<!doctype html>/);
      assert.equal(fx.gitStatus(), '', '그리기는 저장소를 바꾸지 않아요');
    });

    it('화면은 밖에서 아무것도 받지 않는다(글꼴·스크립트·스타일 모두 안에 있다)', () => {
      const html = readFileSync(printed.graph, 'utf8');
      assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    });

    it('검색 순서는 search의 답(많이 쓰이는 것이 먼저)과 같고, 파일도 고를 수 있다', () => {
      const answer = fx.ask('search', '--limit', '1000');
      const names = D.nodes.filter((n: any) => n.d !== 'file').map((n: any) => n.k);
      assert.deepEqual(names.slice(0, answer.results.total), answer.results.items.map((i: any) => i.key));
      const files = D.nodes.filter((n: any) => n.d === 'file').map((n: any) => D.paths[n.p]);
      assert.ok(files.includes('lib/core/money.dart'));
    });

    it('이름을 고르면 정의, 사용처, 영향 범위가 context·impact의 답과 같다', () => {
      const ctx = fx.ask('context', 'withVat');
      const imp = fx.ask('impact', 'withVat');
      const n = R.nodeOf('withVat');
      assert.deepEqual(
        { path: D.paths[n.p], line: n.l, column: n.c, kind: n.d, confidence: R.conf(n.i), source: D.sources[n.s] },
        { ...ctx.symbol.definition, kind: ctx.symbol.kind, confidence: ctx.symbol.confidence, source: ctx.symbol.source },
      );
      assert.equal(ctx.symbol.confidence, layer.confidence);
      assert.deepEqual(R.uses(n), { total: ctx.uses.total, items: ctx.uses.items });
      const a = R.affected(n);
      assert.equal(a.total, imp.summary.affected);
      assert.equal(a.more, imp.summary.moreBeyondDepth);
      assert.deepEqual(n.A[3], imp.summary.byDistance, '거리별 전체 개수(항목이 잘려도 칸 머리말에 써요)');
      assert.deepEqual(
        a.items.map(({ via, ...rest }: any) => rest),
        impactItems(imp),
      );
      assert.ok(a.items.some((i: any) => i.confidence === layer.confidence), '정밀/추정 표시가 항목마다 따라와요');
    });

    it('이웃을 따라갈 수 있다: 영향 받는 곳마다 한 단계 가까운 노드(via)가 있고, 그 노드의 자료도 그 노드의 답과 같다', () => {
      const n = R.nodeOf('withVat');
      const a = R.affected(n);
      const imp = fx.ask('impact', 'withVat');
      // 거리 1은 고른 이름을 바로 써요(via 없음 = 가운데). 그 뒤는 via가 한 단계 가까운 노드예요.
      for (const [i, item] of a.items.entries()) {
        const want = imp.affected.items[i].via.name;
        if (item.distance === 1) assert.equal(item.via, null);
        else assert.equal(item.via, want);
      }
      // 이웃(Cart.total)을 눌러 가면 그 이름의 context·impact가 나와요.
      const next = R.nodeOf('Cart.total');
      const ctx = fx.ask('context', 'Cart.total');
      const nextImpact = fx.ask('impact', 'Cart.total');
      assert.deepEqual(R.uses(next), { total: ctx.uses.total, items: ctx.uses.items });
      assert.deepEqual(R.affected(next).items.map(({ via, ...rest }: any) => rest), impactItems(nextImpact));
    });

    it('파일을 고르면 그 파일이 정의하는 이름, 가져오는 파일, 쓰는 파일과 영향 범위가 그 답과 같다', () => {
      const ctx = fx.ask('context', 'lib/core/money.dart');
      const imp = fx.ask('impact', 'lib/core/money.dart');
      const n = R.nodeOf('lib/core/money.dart');
      const names = (list: any) => [list[0], list[1].map((i: number) => D.nodes[i].k)];
      assert.deepEqual(names(n.F.defines), [ctx.defines.total, ctx.defines.items.map((s: any) => s.key)]);
      const links = (list: any) => [list[0], list[1].map(([i, inf, s, uses]: any[]) => ({ path: D.paths[D.nodes[i].p], confidence: R.conf(inf), source: D.sources[s], ...(uses !== undefined ? { uses } : {}) }))];
      const plain = (page: any) => [page.total, page.items.map((l: any) => ({ path: l.path, confidence: l.confidence, source: l.source, ...(l.uses !== undefined ? { uses: l.uses } : {}) }))];
      assert.deepEqual(links(n.F.imports), plain(ctx.imports));
      assert.deepEqual(links(n.F.importedBy), plain(ctx.importedBy));
      assert.deepEqual(links(n.F.usedBy), plain(ctx.usedBy));
      assert.deepEqual(R.affected(n).items.map(({ via, ...rest }: any) => rest), impactItems(imp));
    });
  });
}
