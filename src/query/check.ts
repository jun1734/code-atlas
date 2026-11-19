// check: 구조 검사. 서로 물린 파일 묶음, 모듈 사이에서 흐름을 거스르는 import와 그 최소 개수, 모듈별 층,
// 다른 모듈에서 가져다 쓰는 리뷰 후보, 어디서도 쓰이지 않는 공개 이름.
// 어느 파일이 어느 모듈인지, 무엇이 공용·조립 모듈이고 허용 목록이 어디 있는지는 저장소 설정(repo-config.ts)이 정해요.
// 봉투(index)는 질의 실행기가 씌워요(src/answer.ts).
import { DEFAULT_LIMIT, page, type Page, type Sourced } from '../answer.ts';
import type { Confidence, SymbolKind } from '../facts.ts';
import type { GraphStore, Location } from '../graph/store.ts';

/** 파일 하나에서 다른 파일로 가는 import(같은 쌍의 관계를 묶은 것). */
interface FileImport extends Sourced {
  from: string;
  to: string;
}
import { globToRegExp, moduleResolver, nameGlobToRegExp } from '../modules.ts';
import type { QueryDef } from '../queries.ts';
import { loadRepoConfig, readAllowlist } from '../repo-config.ts';

export interface CycleItem extends Sourced {
  files: string[];
  modules: string[];
  /** 묶음 안의 import [가져다 쓰는 파일, 가져오는 파일]. */
  imports: [string, string][];
}

export interface BackwardImportItem extends Sourced {
  from: string;
  to: string;
  fromModule: string;
  toModule: string;
  /** 저장소가 적어 둔 허용 목록에 든 것인지. false면 새 위반이에요. */
  allowed: boolean;
}

export interface ReviewCandidateItem extends Sourced {
  target: string;
  module: string;
  from: string[];
}

export interface UnusedNameItem extends Sourced {
  name: string;
  kind: SymbolKind;
  definition: Location;
}

/** check 답의 몸통. */
export interface CheckBody {
  [key: string]: unknown;
  /** 읽은 저장소 설정 파일(저장소 뿌리 기준, 밖이면 절대 경로). 기본 설정이면 null. */
  config: string | null;
  summary: {
    /** 어느 모듈에 든(검사 안의) 파일 수. */
    files: number;
    modules: number;
    cycles: number;
    backwardImports: number;
    /** 흐름을 거스르는 import 가운데 허용 목록에 든 것. */
    allowed: number;
    /** 흐름을 거스르는 import 가운데 허용 목록에 없는 것(새 위반). */
    new: number;
    /** backwardImports가 증명된 최소 개수인지. 서로 도는 모듈 묶음이 22개를 넘으면 이름순으로 두어 최소가 아닐 수 있어요. */
    minimal: boolean;
    reviewCandidates: number;
    unusedPublicNames: number;
  };
  /** 서로 import해서 한 덩어리가 된 파일 묶음(큰 것부터). */
  cycles: Page<CycleItem>;
  /** 모듈을 위(가져다 쓰는 쪽)에서 아래로 세운 순서와 층(흐름을 거스르는 간선을 뺀 뒤, 맨 아래에서의 가장 긴 거리). 모듈 수만큼이라 자르지 않아요. */
  modules: { name: string; layer: number; files: number }[];
  /** 위 순서에서 아래 모듈이 위 모듈을 가져다 쓰는 import. */
  backwardImports: Page<BackwardImportItem>;
  /** 다른 모듈에서 그 모듈의 화면도 provider도 아닌 것(설정의 openToOtherModules에 안 맞는 파일)을 가져다 쓰는 곳. 판정이 아니라 리뷰 후보예요. */
  reviewCandidates: Page<ReviewCandidateItem>;
  /** 검사 안 파일의 최상위 공개 이름 가운데 어디서도(테스트 포함) 쓰이지 않는 것. */
  unusedPublicNames: Page<UnusedNameItem>;
}

/** 여러 import에서 나온 항목의 표시: 가장 낮은 신뢰도와 낸 색인기들. */
function sourcedOf(rows: FileImport[]): Sourced {
  const confidence: Confidence = rows.some((r) => r.confidence === 'inferred') ? 'inferred' : 'precise';
  const sources = new Set(rows.flatMap((r) => r.source.split(',')));
  return { confidence, source: [...sources].sort().join(',') };
}

/** 목록 전체를 앞에서부터 limit개로 잘라 계약의 모양으로. */
const pageOf = <T extends Sourced>(all: T[], limit: number): Page<T> => page(all.slice(0, limit), all.length);

/** Tarjan 강연결 요소. 묶음은 의존되는 쪽(간선이 닿는 쪽)부터 나와요. */
export function stronglyConnected(nodes: string[], next: (v: string) => string[]): string[][] {
  let counter = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of next(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      out.push(group.reverse());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return out;
}

/** 이 크기를 넘는 묶음은 부분집합 DP(2^n)를 하지 않고 받은 순서로 둬요. */
const MAX_EXACT = 22;

/**
 * 서로 도는 모듈 묶음 안에서, 흐름을 거스르는 import 수(간선 무게 합)가 가장 적은 위→아래 순서를 찾아요(부분집합 DP).
 */
function bestOrder(group: string[], weight: (a: string, b: string) => number): string[] {
  const n = group.length;
  if (n === 1 || n > MAX_EXACT) return group;
  const outs = group.map((a) => group.map((b, j) => [j, weight(a, b)] as const).filter(([, w]) => w > 0));
  const cost = new Int32Array(1 << n);
  const last = new Int8Array(1 << n);
  for (let set = 1; set < 1 << n; set++) {
    let best = Infinity;
    let pick = -1;
    for (let v = 0; v < n; v++) {
      if (!((set >> v) & 1)) continue;
      // v를 set의 맨 아래에 둬요. v가 자기보다 위에 놓인 것을 import하면 흐름을 거슬러요.
      let c = cost[set ^ (1 << v)]!;
      for (const [u, w] of outs[v]!) if ((set >> u) & 1) c += w;
      if (c < best) {
        best = c;
        pick = v;
      }
    }
    cost[set] = best;
    last[set] = pick;
  }
  const order: string[] = [];
  for (let set = (1 << n) - 1; set; set ^= 1 << last[set]!) order.unshift(group[last[set]!]!);
  return order;
}

/** 색인과 저장소 설정으로 구조를 검사해요. configPath가 없으면 색인한 저장소 뿌리의 .code-atlas.json(없으면 기본 설정)을 써요. */
export function check(store: GraphStore, limit: number, configPath?: string): CheckBody {
  const meta = store.meta();
  const config = loadRepoConfig(meta.repoRoot, configPath);
  const moduleOf = moduleResolver(config);

  // 1. 검사 안 파일과 그 사이의 import.
  const files = store.filePaths().filter((p) => moduleOf(p) !== null);
  const inScope = new Set(files);
  const imports: FileImport[] = files.flatMap((from) =>
    store
      .importsOf(from)
      .filter((t) => t.path !== from && inScope.has(t.path))
      .map((t) => ({ from, to: t.path, confidence: t.confidence, source: t.source }))
      .sort((a, b) => a.to.localeCompare(b.to)),
  );
  const importsOf = new Map<string, string[]>();
  for (const i of imports) (importsOf.get(i.from) ?? importsOf.set(i.from, []).get(i.from)!).push(i.to);
  const mod = (p: string) => moduleOf(p)!;

  // 2. 서로 물린 파일 묶음.
  const cycles: CycleItem[] = stronglyConnected(files, (f) => importsOf.get(f) ?? [])
    .filter((g) => g.length > 1)
    .map((group) => {
      const sorted = [...group].sort();
      const inGroup = new Set(group);
      const inner = imports.filter((i) => inGroup.has(i.from) && inGroup.has(i.to));
      return {
        files: sorted,
        modules: [...new Set(sorted.map(mod))].sort(),
        imports: inner.map((i) => [i.from, i.to] as [string, string]),
        ...sourcedOf(inner),
      };
    })
    .sort((a, b) => b.files.length - a.files.length || a.files[0]!.localeCompare(b.files[0]!));

  // 3. 모듈 사이 간선과 순서. 가져다 쓰는 쪽이 위예요.
  const moduleNames = [...new Set(files.map(mod))].sort();
  const edges = new Map<string, typeof imports>();
  for (const i of imports) {
    const a = mod(i.from);
    const b = mod(i.to);
    if (a === b) continue;
    const k = `${a}\0${b}`;
    (edges.get(k) ?? edges.set(k, []).get(k)!).push(i);
  }
  const weight = (a: string, b: string) => edges.get(`${a}\0${b}`)?.length ?? 0;
  const moduleGroups = stronglyConnected(moduleNames, (m) => moduleNames.filter((x) => weight(m, x) > 0));
  const order = [...moduleGroups].reverse().flatMap((g) => bestOrder(g, weight));
  const position = new Map(order.map((m, i) => [m, i]));
  const minimal = moduleGroups.every((g) => g.length <= MAX_EXACT);

  // 층: 흐름을 거스르는 간선을 뺐을 때, 맨 아래부터의 가장 긴 거리. 순서를 아래에서 위로 훑어요.
  const layer = new Map<string, number>();
  for (const m of [...order].reverse()) {
    const below = moduleNames.filter((x) => weight(m, x) > 0 && position.get(m)! < position.get(x)!);
    layer.set(m, Math.max(0, ...below.map((x) => layer.get(x)! + 1)));
  }

  // 4. 흐름을 거스르는 import와 허용 목록.
  const allowlist = new Set(readAllowlist(meta.repoRoot, config.allowlist));
  const backwardImports: BackwardImportItem[] = imports
    .filter((i) => position.get(mod(i.from))! > position.get(mod(i.to))!)
    .map((i) => ({
      from: i.from,
      to: i.to,
      fromModule: mod(i.from),
      toModule: mod(i.to),
      allowed: allowlist.has(i.to),
      confidence: i.confidence,
      source: i.source,
    }));

  // 5. 리뷰 후보: 다른 모듈에서, 공용 모듈도 아니고 다른 모듈에 열린 파일(화면, provider 등)도 아닌 것을 가져다 쓰는 곳.
  // 조립 모듈이 가져다 쓰는 것은 빼요.
  const definitions = store.definitions();
  const openFiles = config.openToOtherModules.files.map(globToRegExp);
  const openSymbols = config.openToOtherModules.symbols.map((s) => ({ kinds: s.kinds, re: nameGlobToRegExp(s.name) }));
  const openByFile = new Set(files.filter((f) => openFiles.some((re) => re.test(f))));
  for (const d of definitions) {
    if (!inScope.has(d.definition.path)) continue;
    if (openSymbols.some((s) => (!s.kinds || s.kinds.includes(d.kind)) && s.re.test(d.name))) openByFile.add(d.definition.path);
  }
  const shared = new Set(config.shared);
  const composers = new Set(config.composers);
  const candidates = new Map<string, FileImport[]>();
  for (const i of imports) {
    const a = mod(i.from);
    const b = mod(i.to);
    if (a === b || shared.has(b) || composers.has(a) || openByFile.has(i.to)) continue;
    (candidates.get(i.to) ?? candidates.set(i.to, []).get(i.to)!).push(i);
  }
  const reviewCandidates: ReviewCandidateItem[] = [...candidates]
    .map(([target, rows]) => ({ target, module: mod(target), from: rows.map((r) => r.from).sort(), ...sourcedOf(rows) }))
    .sort((a, b) => b.from.length - a.from.length || a.target.localeCompare(b.target));

  // 6. 쓰이지 않는 공개 이름: 검사 안 파일의 최상위 선언 가운데, 그것도 그 안의 것(생성자, 멤버)도 쓰인 적이 없는 것.
  // 멤버 하나하나는 보지 않아요. 프레임워크가 부르는 재정의(build 등)를 그래프가 아직 가려내지 못해서요.
  const parentOf = new Map(definitions.map((d) => [d.key, d.parentKey]));
  // 정의가 없는 사용처 열쇠(선언하지 않은 기본 생성자 `C#<constructor>().` 등)는 심볼 열쇠에서 바깥 타입(`C#`)을 잘라 올라가요.
  const up = (k: string): string | null => {
    if (parentOf.has(k)) return parentOf.get(k)!;
    const hash = k.lastIndexOf('#', k.length - 2);
    return hash > 0 ? k.slice(0, hash + 1) : null;
  };
  const used = new Set<string>();
  for (const key of store.referencedKeys()) {
    for (let k: string | null = key; k && !used.has(k); k = up(k)) used.add(k);
  }
  const isPrivate = nameGlobToRegExp(config.unused.private);
  const ignore = new Set(config.unused.ignore);
  const unused = definitions.filter(
    (d) =>
      d.parentKey === null &&
      d.kind !== 'namespace' &&
      inScope.has(d.definition.path) &&
      !isPrivate.test(d.name) &&
      !ignore.has(d.name) &&
      !used.has(d.key),
  );

  return {
    config: config.path,
    summary: {
      files: files.length,
      modules: moduleNames.length,
      cycles: cycles.length,
      backwardImports: backwardImports.length,
      allowed: backwardImports.filter((b) => b.allowed).length,
      new: backwardImports.filter((b) => !b.allowed).length,
      minimal,
      reviewCandidates: reviewCandidates.length,
      unusedPublicNames: unused.length,
    },
    cycles: pageOf(cycles, limit),
    modules: order.map((name) => ({ name, layer: layer.get(name)!, files: files.filter((f) => mod(f) === name).length })),
    backwardImports: pageOf(backwardImports, limit),
    reviewCandidates: pageOf(reviewCandidates, limit),
    unusedPublicNames: pageOf(
      unused.map((d) => ({ name: d.name, kind: d.kind, definition: d.definition, confidence: d.confidence, source: d.source })),
      limit,
    ),
  };
}

export const checkQuery: QueryDef = {
  name: 'check',
  description:
    '저장소 구조를 검사해요: 서로 import해서 물린 파일 묶음, 모듈 사이에서 흐름을 거스르는 import(최소 개수, 허용 목록에 든 것과 새 위반 구분)와 모듈별 층, ' +
    '다른 기능 모듈의 화면도 provider도 아닌 것을 가져다 쓰는 리뷰 후보, 어디서도 쓰이지 않는 공개 이름. ' +
    '리팩터링 전후나 리뷰 때 모듈 경계가 무너졌는지 볼 때 불러요. 모듈 기준은 저장소 뿌리의 .code-atlas.json이 정해요.',
  params: [
    {
      name: 'config',
      type: 'string',
      description: '저장소 설정 파일 경로. 없으면 색인한 저장소 뿌리의 .code-atlas.json, 그것도 없으면 기본 설정(뿌리 바로 아래 폴더 하나가 모듈 하나).',
    },
    { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '목록마다 앞에서부터 몇 개까지 줄지.' },
  ],
  run: (store, args) => check(store, args.limit as number, args.config as string | undefined),
};