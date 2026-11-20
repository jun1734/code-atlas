// scip-typescript가 낸 사실을 JS/TS 관례에 맞게 다듬어요. 언어를 아는 일이라 어댑터 안에 둬요.
//
// 1) 파일의 언어(javascript/typescript)와 역할(테스트)을 붙여요.
// 2) 매개변수·타입 매개변수 심볼과 CommonJS 내보내기 목록이 만든 속성 심볼(`withTax0:`)은 넣지 않아요.
// 3) 심볼 열쇠를 사람이 묻는 이름에 맞춰요: 생성자는 클래스로, getter/setter는 그 이름으로.
// 4) 이름을 가져오거나 내보내기만 하는 자리(import 이름, require 구조 분해, export 목록)는 사용처에서 빼요.
// 5) 사용처의 종류(읽기, 쓰기, 호출, 상속, 구현)를 가려요. scip-typescript 0.6.2는 읽기/쓰기 역할을 주지 않아서
//    구문(Tree-sitter)으로 가리고 kindConfidence를 inferred로 둬요. 상속·구현은 scip-typescript가 준 타입 관계
//    (supertypes)로 확인한 것만 precise예요. scip-typescript가 주지 않은 정의 전체의 자리(enclosingRange)도 구문으로 채워요.
// 6) scip-typescript가 아무것도 잇지 못한 자리(occurrence가 하나도 없는 자리)는 추정 층이 이은 것을 추정으로 붙여요.
//    예: JSDoc의 `@implements {X}`·`@type {X}`. 수신자.이름(수신자가 any)은 메우지 않아요(fillGaps).
import { emptyFacts, type Facts, type Range, type RelationFact, type RelationKind, type RepoInfo, type SymbolFact, type SymbolKind } from '../facts.ts';
import { inferredSource, runInferred, type RepoView } from '../inferred/layer.ts';
import { parserFor } from '../inferred/tree-sitter.ts';
import { extractJsTs, typescriptInferred, type JsTsSyntax } from '../inferred/typescript.ts';
import { parseSymbol, symbolNames } from '../scip/symbol.ts';
import { jsTsGrammar, jsTsLanguage, jsTsRole } from './typescript-conventions.ts';

export interface RefineOptions {
  repo: RepoInfo;
  view: RepoView;
  /** 파일마다 scip-typescript의 occurrence가 있는 자리('줄:열', 지역 이름과 저장소 밖 이름 포함). */
  positions: Record<string, string[]>;
}

const at = (path: string, line: number, column: number) => `${path}:${line}:${column}`;

export async function refineTypeScriptFacts(raw: Facts, opts: RefineOptions): Promise<Facts> {
  // 1) 파일
  const files = raw.files.map((f) => ({ ...f, language: jsTsLanguage(f.path), role: jsTsRole(f.path) }));
  const covered = new Set(files.map((f) => f.path));

  // 2) 넣지 않는 심볼
  const lastSuffix = (key: string) => parseSymbol(key).descriptors.at(-1)?.suffix;
  const unwanted = (key: string) => {
    const suffix = lastSuffix(key);
    return suffix === 'parameter' || suffix === 'type-parameter' || suffix === 'meta';
  };

  // 3) 열쇠 맞추기
  const accessorKind = new Map<string, SymbolKind>();
  const rename = (key: string): string => {
    const renamed = renameKey(key);
    if (renamed.accessor && !accessorKind.has(renamed.key)) accessorKind.set(renamed.key, renamed.accessor);
    return renamed.key;
  };
  const symbols: SymbolFact[] = [];
  const seen = new Set<string>();
  for (const s of raw.symbols) {
    if (unwanted(s.key) || s.kind === 'parameter') continue;
    const key = rename(s.key);
    // 생성자는 클래스와, getter와 setter는 서로 같은 열쇠가 돼요. 먼저 나온 정의(클래스, getter)를 둬요.
    if (seen.has(key)) continue;
    seen.add(key);
    const names = key === s.key ? null : symbolNames(parseSymbol(key));
    symbols.push({
      ...s,
      key,
      ...(names ? { name: names.name, qualifiedName: names.qualifiedName } : {}),
      kind: accessorKind.get(key) ?? s.kind,
      ...(s.parentKey ? { parentKey: rename(s.parentKey) } : {}),
      ...(s.supertypes ? { supertypes: s.supertypes.map(rename) } : {}),
    });
  }
  const byKey = new Map(symbols.map((s) => [s.key, s]));

  // 4), 5) 사용처: 파일마다 구문을 읽어 이름 자리의 종류와 가져오기만 하는 자리를 알아요.
  const syntax = new Map<string, { kinds: Map<string, RelationKind>; bindings: Set<string>; members: Set<string> }>();
  for (const f of files) {
    const text = opts.view.read(f.path);
    if (text === null) continue;
    const parser = await parserFor(jsTsGrammar(f.path));
    const tree = parser.parse(text);
    parser.delete();
    if (!tree) continue;
    const s: JsTsSyntax = extractJsTs(tree.rootNode);
    tree.delete();
    syntax.set(f.path, {
      kinds: new Map(s.references.map((r) => [`${r.range.startLine}:${r.range.startColumn}`, r.kind])),
      bindings: new Set(s.bindings.map((b) => `${b.startLine}:${b.startColumn}`)),
      members: new Set(s.references.filter((r) => r.member).map((r) => `${r.range.startLine}:${r.range.startColumn}`)),
    });
    // scip-typescript는 여러 줄에 걸친 변수 선언(`export const x = { … }`) 등에 정의 전체의 자리(enclosingRange)를 주지 않아요.
    // 같은 자리의 구문 정의로 채워요. 그 안의 사용처를 감싸는 심볼(in)과 impact의 출발점이 이것으로 정해져요.
    const extents = new Map(s.definitions.map((d) => [`${d.range.startLine}:${d.range.startColumn}`, d.enclosingRange]));
    for (const sym of symbols) {
      if (sym.path !== f.path || sym.enclosingRange) continue;
      const extent = extents.get(`${sym.range.startLine}:${sym.range.startColumn}`);
      if (extent) sym.enclosingRange = extent;
    }
  }
  const innermost = enclosingFinder(symbols);

  const relations: RelationFact[] = [];
  for (const r0 of raw.relations) {
    if ('symbolKey' in r0.to && unwanted(r0.to.symbolKey)) continue;
    // CommonJS의 `module.exports`는 scip-typescript가 그 파일 자신을 가리키는 occurrence로 적어요. 자기 자신을 가져오는 import가 아니에요.
    if ('path' in r0.to && r0.to.path === r0.from.path) continue;
    const pos = `${r0.from.range.startLine}:${r0.from.range.startColumn}`;
    const fileSyntax = syntax.get(r0.from.path);
    if (r0.kind !== 'import' && fileSyntax?.bindings.has(pos)) continue;
    const fromKey = r0.from.symbolKey ? rename(r0.from.symbolKey) : innermost(r0.from.path, r0.from.range);
    const r: RelationFact = {
      ...r0,
      from: { ...r0.from, ...(fromKey ? { symbolKey: fromKey } : {}) },
      to: 'symbolKey' in r0.to ? { symbolKey: rename(r0.to.symbolKey) } : r0.to,
    };
    if (r.kind === 'reference' && 'symbolKey' in r.to) {
      const target = r.to.symbolKey;
      const isType = lastSuffix(target) === 'type';
      let kind = fileSyntax?.kinds.get(pos) ?? (isType ? 'reference' : 'read');
      if (isType && kind === 'read') kind = 'reference';
      const enclosing = r.from.symbolKey ? byKey.get(r.from.symbolKey) : undefined;
      const confirmed = (kind === 'extends' || kind === 'implements') && !!enclosing?.supertypes?.includes(target);
      r.kind = kind;
      r.kindConfidence = confirmed ? 'precise' : 'inferred';
    }
    relations.push(r);
  }

  // 6) scip-typescript가 잇지 못한 자리를 추정 층으로 메워요.
  relations.push(...(await fillGaps(opts, covered, symbols, (path) => syntax.get(path)?.members ?? new Set())));
  return { files, symbols, relations };
}

/** 파일의 자리를 품는 가장 안쪽 정의의 열쇠를 찾는 함수(채운 enclosingRange로 다시 찾을 때 써요). */
function enclosingFinder(symbols: SymbolFact[]): (path: string, range: Range) => string | undefined {
  const byFile = new Map<string, SymbolFact[]>();
  for (const s of symbols) {
    if (!s.enclosingRange) continue;
    const list = byFile.get(s.path) ?? [];
    list.push(s);
    byFile.set(s.path, list);
  }
  const before = (a: { line: number; col: number }, b: { line: number; col: number }) => a.line < b.line || (a.line === b.line && a.col <= b.col);
  return (path, range) => {
    let best: SymbolFact | undefined;
    for (const s of byFile.get(path) ?? []) {
      const e = s.enclosingRange!;
      const inside =
        before({ line: e.startLine, col: e.startColumn }, { line: range.startLine, col: range.startColumn }) &&
        before({ line: range.endLine, col: range.endColumn }, { line: e.endLine, col: e.endColumn });
      if (!inside) continue;
      const b = best?.enclosingRange;
      if (!b || before({ line: b.startLine, col: b.startColumn }, { line: e.startLine, col: e.startColumn })) best = s;
    }
    return best?.key;
  };
}

/**
 * 추정 층을 돌려, scip-typescript의 occurrence가 하나도 없는 자리에서 추정 층이 이은 사용처를 가져와요.
 * 추정 층의 심볼 열쇠는 같은 자리(경로, 이름의 줄·열)의 정밀 심볼 열쇠로 바꿔요. 바꿀 수 없으면 버려요.
 * 이렇게 붙은 사용처는 confidence·kindConfidence가 inferred, source가 추정 층(tree-sitter-typescript)이에요.
 */
async function fillGaps(
  opts: RefineOptions,
  covered: Set<string>,
  symbols: SymbolFact[],
  memberAt: (path: string) => Set<string>,
): Promise<RelationFact[]> {
  const guessed = await runInferred(typescriptInferred, opts.repo, { emit: (p) => covered.has(p), precise: emptyFacts() });
  const preciseAt = new Map(symbols.map((s) => [at(s.path, s.range.startLine, s.range.startColumn), s.key]));
  const toPrecise = new Map<string, string>();
  for (const s of guessed.symbols) {
    const key = preciseAt.get(at(s.path, s.range.startLine, s.range.startColumn));
    if (key) toPrecise.set(s.key, key);
  }
  const occupied = new Map(Object.entries(opts.positions).map(([path, list]) => [path, new Set(list)]));
  const source = inferredSource(typescriptInferred);
  const out: RelationFact[] = [];
  for (const r of guessed.relations) {
    if (r.kind === 'import' || !('symbolKey' in r.to)) continue;
    const pos = `${r.from.range.startLine}:${r.from.range.startColumn}`;
    if (occupied.get(r.from.path)?.has(pos)) continue;
    // 수신자.이름은 메우지 않아요. scip-typescript가 잇지 못한 멤버는 수신자가 any(대개 저장소 밖 값: JSON, 외부 모듈)라서
    // 이름만으로 이으면 틀린 것이 더 많았어요(code-atlas 자신에서 288개 가운데 대부분이 RepoConfig.map, CliResult.status 같은 잘못 이음).
    if (memberAt(r.from.path).has(pos)) continue;
    const target = toPrecise.get(r.to.symbolKey);
    if (!target) continue;
    const enclosing = r.from.symbolKey ? toPrecise.get(r.from.symbolKey) : undefined;
    out.push({
      ...r,
      from: { path: r.from.path, range: r.from.range, ...(enclosing ? { symbolKey: enclosing } : {}) },
      to: { symbolKey: target },
      confidence: 'inferred',
      kindConfidence: 'inferred',
      source,
    });
  }
  return out;
}

/**
 * scip-typescript의 열쇠를 사람이 묻는 이름에 맞춰요.
 *   Cart#`<constructor>`().   → Cart#          (생성자를 부르는 곳(new Cart())은 클래스를 쓰는 곳이에요)
 *   Labeled#`<get>label`().   → Labeled#label. (getter)
 *   Labeled#`<set>label`().   → Labeled#label. (setter)
 */
function renameKey(key: string): { key: string; accessor?: SymbolKind } {
  if (key.endsWith('#`<constructor>`().')) return { key: key.slice(0, -'`<constructor>`().'.length) };
  const m = /`<(get|set)>([^`]+)`(?:\(\))?\.$/.exec(key);
  if (!m) return { key };
  const name = /^[\w+$-]+$/.test(m[2]!) ? m[2]! : `\`${m[2]}\``;
  return { key: `${key.slice(0, m.index)}${name}.`, accessor: m[1] === 'get' ? 'getter' : 'setter' };
}
