// scip-python이 낸 사실을 Python 관례에 맞게 다듬어요. 언어를 아는 일이라 어댑터 안에 둬요.
//
// scip-python 0.6.8은 심볼의 종류(SymbolInformation.kind)와 읽기/쓰기 역할을 주지 않아요(사용처는 모두 ReadAccess).
// 그래서 소스를 tree-sitter-python으로 읽어(추정 규칙과 같은 구문 읽기, src/inferred/python.ts) 다음을 채워요.
//
// 1) 생성된 코드, 빌드 산출물, 가상 환경 안의 파일을 빼요. 테스트 파일에 test 역할을 붙여요.
// 2) 매개변수 심볼(`f().(x)`)은 빼요(다른 언어의 정밀 층도 지역 이름을 넣지 않아요).
// 3) 정의의 종류: 선언의 문법(class, def, @property, __init__, Final 등)으로 정해요. 정의 자체는 scip-python이 준 것이라 precise로 둬요.
//    모듈 수준 변수에는 scip-python이 정의 범위(enclosingRange)를 주지 않아서 대입문의 범위를 채워요(사용처의 in을 정하는 데 써요).
// 4) import: scip-python은 모듈을 `<모듈>/__init__:` 심볼로 가리켜요. 그 자리의 import 문을 Python 모듈 규칙으로 파일에 풀어
//    파일→파일 import 관계로 바꿔요(상대 import `from .cart import …`의 모듈 심볼은 scip-python이 `cart/__init__:`처럼
//    패키지를 빼고 적어서 심볼 이름으로는 풀 수 없어요).
// 5) 사용처의 종류: 문법으로 가리고(kindConfidence: inferred), 상속은 scip-python이 준 타입 관계(supertypes)로 확인한 것만
//    extends로 부르고 precise로 둬요. Python의 바탕 타입은 하나의 방법(상속)이라 implements는 쓰지 않아요.
import { HEAD_LENGTH } from './conventions.ts';
import { dropFiles, placeKey, positionKey, TYPE_KINDS, type Facts, type Range, type RelationFact, type SymbolFact, type SymbolKind } from '../facts.ts';
import { parserFor } from '../inferred/tree-sitter.ts';
import { pythonSyntax, type PythonSyntax } from '../inferred/python.ts';
import { parseSymbol } from '../scip/symbol.ts';
import { isExcludedPython, ownsPython, pythonRole, resolvePythonModule } from './python-conventions.ts';

export interface PythonRefineOptions {
  /** 저장소 기준 경로의 소스 글. 읽지 못하면 null. */
  readText: (path: string) => string | null;
  /** 저장소의 파일(무시된 파일 제외). import 대상을 풀 때 써요. */
  files: ReadonlySet<string>;
  /** Python 프로젝트 뿌리들(python-conventions.ts의 pythonProjects). */
  projects: string[];
}

function contains(outer: Range, inner: Range): boolean {
  const after = inner.startLine > outer.startLine || (inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn);
  const before = inner.endLine < outer.endLine || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return after && before;
}

const size = (r: Range) => (r.endLine - r.startLine) * 100000 + (r.endColumn - r.startColumn);

/** 모듈을 가리키는 심볼(`shop.cart/__init__:`)이거나 모듈 자체(`` `bin.checkout`/ ``)인지. */
function isModuleSymbol(key: string): boolean {
  const parsed = parseSymbol(key);
  if (parsed.local) return false;
  const last = parsed.descriptors.at(-1);
  return !last || last.suffix === 'namespace' || (last.suffix === 'meta' && last.name === '__init__');
}

const isParameter = (key: string) => parseSymbol(key).descriptors.some((d) => d.suffix === 'parameter');

/** 문법으로 정하지 못한 정의의 종류: 심볼 꼴(타입 `#`, 부르는 것 `().`, 값 `.`)과 바깥이 타입인지로 정해요. */
function fallbackKind(s: SymbolFact, parentIsType: boolean): SymbolKind {
  const last = parseSymbol(s.key).descriptors.at(-1);
  if (last?.suffix === 'type') return 'class';
  if (last?.suffix === 'method') return parentIsType ? 'method' : 'function';
  if (last?.suffix === 'term') return parentIsType ? 'field' : 'variable';
  return s.kind;
}

export async function refinePythonFacts(raw: Facts, opts: PythonRefineOptions): Promise<Facts> {
  // 1) 뺄 파일과 역할
  const facts = dropFiles(raw, (path) => !ownsPython(path) || isExcludedPython(path, opts.readText(path)?.slice(0, HEAD_LENGTH) ?? ''));
  for (const f of facts.files) f.role = pythonRole(f.path);

  const parser = await parserFor('python');
  const syntax = new Map<string, PythonSyntax>();
  for (const f of facts.files) {
    const text = opts.readText(f.path);
    const tree = text === null ? null : parser.parse(text);
    if (!tree) continue;
    syntax.set(f.path, pythonSyntax(tree.rootNode));
    tree.delete();
  }
  parser.delete();

  // 2), 3) 정의
  const defAt = new Map<string, { kind: SymbolKind; enclosingRange: Range }>();
  for (const [path, s] of syntax) {
    for (const d of s.file.definitions) defAt.set(placeKey(path, d.range.startLine, d.range.startColumn), d);
  }
  const typeKeys = new Set(facts.symbols.filter((s) => parseSymbol(s.key).descriptors.at(-1)?.suffix === 'type').map((s) => s.key));
  const symbols: SymbolFact[] = facts.symbols
    .filter((s) => !isParameter(s.key))
    .map((s) => {
      const d = defAt.get(placeKey(s.path, s.range.startLine, s.range.startColumn));
      const kind = d?.kind ?? fallbackKind(s, s.parentKey !== undefined && typeKeys.has(s.parentKey));
      const enclosingRange = s.enclosingRange ?? d?.enclosingRange;
      return { ...s, kind, ...(enclosingRange ? { enclosingRange } : {}) };
    });
  const byKey = new Map(symbols.map((s) => [s.key, s]));
  const defsByFile = new Map<string, SymbolFact[]>();
  for (const s of symbols) if (s.enclosingRange) defsByFile.set(s.path, [...(defsByFile.get(s.path) ?? []), s]);
  const enclosing = (path: string, range: Range): SymbolFact | undefined =>
    (defsByFile.get(path) ?? []).filter((d) => contains(d.enclosingRange!, range)).sort((a, b) => size(a.enclosingRange!) - size(b.enclosingRange!))[0];

  // 4), 5) 관계
  const relations: RelationFact[] = [];
  const seenImports = new Set<string>();
  for (const r of facts.relations) {
    if ('path' in r.to) {
      relations.push(r);
      continue;
    }
    const key = r.to.symbolKey;
    const at = positionKey(r.from.range.startLine, r.from.range.startColumn);
    const file = syntax.get(r.from.path);
    const encl = enclosing(r.from.path, r.from.range);
    const from = { path: r.from.path, range: r.from.range, ...(encl ? { symbolKey: encl.key } : {}) };
    if (isModuleSymbol(key)) {
      const imp = file?.file.imports.find((i) => i.range.startLine === r.from.range.startLine && i.range.startColumn === r.from.range.startColumn);
      const target = imp ? resolvePythonModule(r.from.path, imp.spec, opts.files, opts.projects) : null;
      const id = `${r.from.path}:${at}:${target}`;
      if (target === null || target === r.from.path || seenImports.has(id)) continue;
      seenImports.add(id);
      relations.push({ ...r, kind: 'import', from, to: { path: target }, kindConfidence: 'precise' });
      continue;
    }
    if (isParameter(key)) continue;
    const target = byKey.get(key);
    let kind = file?.kindAt.get(at) ?? 'reference';
    let kindConfidence: RelationFact['kindConfidence'] = 'inferred';
    if (kind === 'extends') {
      if (target && encl && TYPE_KINDS.has(encl.kind) && (encl.supertypes ?? []).includes(key)) kindConfidence = 'precise';
      else kind = 'reference';
    } else if (kind === 'read' && target && TYPE_KINDS.has(target.kind)) kind = 'reference';
    relations.push({ ...r, kind, from, kindConfidence });
  }
  relations.push(...importedNameGaps(syntax, symbols, relations, opts, enclosing));
  return { files: facts.files, symbols, relations };
}

/**
 * 6) scip-python이 놓친 `from 모듈 import 이름`의 이름을 메워요(confidence: inferred).
 * scip-python 0.6.8은 다른 함수에서 `global`로 다시 대입하는 모듈 변수를 가져오는 이름을 지역 심볼(`local N`)로 적어서
 * 그 import가 사용처에서 빠져요. 그 자리에 정밀 관계가 없고, 모듈이 저장소 안 파일로 풀리고, 그 파일(또는 그 파일이 다시
 * 가져온 곳)에 그 이름의 최상위 정의가 있으면 이어요. 이름으로 이은 것이라 추정으로 표시해요.
 */
function importedNameGaps(
  syntax: Map<string, PythonSyntax>,
  symbols: SymbolFact[],
  relations: RelationFact[],
  opts: PythonRefineOptions,
  enclosing: (path: string, range: Range) => SymbolFact | undefined,
): RelationFact[] {
  const linked = new Set(relations.filter((r) => 'symbolKey' in r.to).map((r) => placeKey(r.from.path, r.from.range.startLine, r.from.range.startColumn)));
  const topLevel = new Map<string, SymbolFact>();
  for (const s of symbols) if (s.parentKey === undefined) topLevel.set(`${s.path}:${s.name}`, s);
  /** 모듈 파일에서 이름의 최상위 정의를 찾아요. 그 파일이 다시 가져온 이름이면 따라가요(5번까지). */
  const find = (file: string, name: string, depth: number): SymbolFact | undefined => {
    const hit = topLevel.get(`${file}:${name}`);
    if (hit || depth === 0) return hit;
    for (const n of syntax.get(file)?.importedNames ?? []) {
      if (n.name !== name) continue;
      const next = resolvePythonModule(file, n.module, opts.files, opts.projects);
      const found = next ? find(next, name, depth - 1) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const out: RelationFact[] = [];
  for (const [path, s] of syntax) {
    for (const n of s.importedNames) {
      if (linked.has(placeKey(path, n.range.startLine, n.range.startColumn))) continue;
      const file = resolvePythonModule(path, n.module, opts.files, opts.projects);
      const target = file ? find(file, n.name, 5) : undefined;
      if (!target) continue;
      const encl = enclosing(path, n.range);
      out.push({
        kind: 'reference',
        from: { path, range: n.range, ...(encl ? { symbolKey: encl.key } : {}) },
        to: { symbolKey: target.key },
        confidence: 'inferred',
        kindConfidence: 'inferred',
        source: 'scip-python',
      });
    }
  }
  return out;
}
