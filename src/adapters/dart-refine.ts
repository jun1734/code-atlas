// scip-dart가 낸 사실을 Dart 관례에 맞게 다듬어요. 언어를 아는 일이라 어댑터 안에 둬요.
//
// 1) 생성된 코드와 빌드 산출물을 빼요.
// 2) 테스트 파일에 test 역할을 붙여요.
// 3) 심볼 열쇠를 사람이 묻는 이름에 맞춰요: 이름 없는 생성자는 클래스로, getter/setter는 그 이름으로.
// 4) 최상위·정적 const는 상수(constant)로 표시해요.
// 5) 사용처의 종류(읽기, 쓰기, 호출, 상속, 구현)를 가려요. scip-dart 1.8.1은 읽기/쓰기 역할을 주지 않아서
//    소스의 문법으로 가리고 kindConfidence를 inferred로 둬요. 상속·구현은 scip-dart가 준 타입 관계
//    (supertypes)로 확인한 것만 그렇게 부르고 precise로 둬요.
import { HEAD_LENGTH } from './conventions.ts';
import type { Facts, RelationFact, RelationKind, SymbolFact, SymbolKind } from '../facts.ts';
import { dropFiles } from '../facts.ts';
import { canonicalKey, parseSymbol, symbolNames } from '../scip/symbol.ts';
import { dartRole, isGeneratedDart } from './dart-conventions.ts';

export interface RefineOptions {
  /** 패키지가 저장소 뿌리에서 떨어진 경로('' 또는 'packages/foo'). */
  pathPrefix: string;
  /** 저장소 기준 경로의 소스 글. 읽지 못하면 null. */
  readText: (path: string) => string | null;
}

export function refineDartFacts(raw: Facts, opts: RefineOptions): Facts {
  const inPackage = (path: string) => (opts.pathPrefix ? path.slice(opts.pathPrefix.length + 1) : path);
  const sources = new Map<string, Source | null>();
  const source = (path: string): Source | null => {
    if (!sources.has(path)) {
      const text = opts.readText(path);
      sources.set(path, text === null ? null : toSource(text));
    }
    return sources.get(path)!;
  };

  // 1) 생성된 코드와 빌드 산출물
  const generated = (path: string) => isGeneratedDart(inPackage(path), source(path)?.text.slice(0, HEAD_LENGTH) ?? '');
  const facts = dropFiles(raw, generated);

  // 2) 테스트 파일
  for (const f of facts.files) f.role = dartRole(inPackage(f.path));

  // 3) 열쇠 맞추기
  const accessorKind = new Map<string, SymbolKind>(); // 바꾼 열쇠 → getter/setter
  const rename = (key: string): string => {
    const renamed = canonicalKey(key);
    if (renamed.accessor && !accessorKind.has(renamed.key)) accessorKind.set(renamed.key, renamed.accessor);
    return renamed.key;
  };
  const symbols: SymbolFact[] = [];
  const seen = new Set<string>();
  for (const s of facts.symbols) {
    const key = rename(s.key);
    // 이름 없는 생성자는 클래스와, getter와 setter는 서로 같은 열쇠가 돼요. 먼저 나온 정의(클래스, getter)를 둬요.
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
  const relations: RelationFact[] = facts.relations.map((r) => ({
    ...r,
    from: { ...r.from, ...(r.from.symbolKey ? { symbolKey: rename(r.from.symbolKey) } : {}) },
    to: 'symbolKey' in r.to ? { symbolKey: rename(r.to.symbolKey) } : r.to,
  }));

  // 4) 상수와 인터페이스: 선언문에서 이름 앞의 열쇠말로 가려요(scip-dart는 둘 다 따로 알려 주지 않아요).
  for (const s of symbols) {
    const head = () => declarationHead(source(s.path), s);
    if ((s.kind === 'variable' || s.kind === 'field') && /(^|[^\w$])const\s/.test(head())) s.kind = 'constant';
    if (s.kind === 'class' && /(^|[^\w$])abstract\s+interface\s+class\s+$/.test(head())) s.kind = 'interface';
  }

  // 5) 사용처의 종류
  const byKey = new Map(symbols.map((s) => [s.key, s]));
  for (const r of relations) {
    if (r.kind !== 'reference' || !('symbolKey' in r.to)) continue;
    const src = source(r.from.path);
    if (src === null) continue;
    const kind = classify(src, r, r.to.symbolKey, r.from.symbolKey ? byKey.get(r.from.symbolKey) : undefined);
    r.kind = kind.kind;
    r.kindConfidence = kind.confidence;
  }
  return { files: facts.files, symbols, relations };
}

/** 소스 글과 줄마다의 시작 위치. */
interface Source {
  text: string;
  lineStarts: number[];
}

function toSource(text: string): Source {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return { text, lineStarts };
}

/** 0부터 세는 줄·열을 글 안의 위치로. scip-dart의 열은 UTF-16 단위라 JS 문자열 위치와 같아요. */
function offsetOf(src: Source, line: number, column: number): number {
  return (src.lineStarts[line] ?? src.text.length) + column;
}

/** 선언문에서 이름 앞까지의 글(같은 문장 안에서만: 앞의 ';', '{', '}' 뒤부터). 소스를 읽지 못하면 빈 글. */
function declarationHead(src: Source | null, s: SymbolFact): string {
  if (src === null) return '';
  const at = offsetOf(src, s.range.startLine, s.range.startColumn);
  const before = src.text.slice(Math.max(0, at - 300), at);
  return before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1);
}

/** 대입(쓰기)으로 보는 연산자. ==와 =>는 빼요. */
const ASSIGN_AFTER = /^(=(?![=>])|\+=|-=|\*=|\/=|~\/=|%=|<<=|>>>=|>>=|&=|\|=|\^=|\?\?=|\+\+|--)/;

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

/** 위치 i의 '<'에서 시작하는 타입 인자를 건너뛰어요. 짝이 맞지 않으면 i를 그대로 돌려줘요. */
function skipTypeArgs(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (c === '<') depth++;
    else if (c === '>') {
      depth--;
      if (depth === 0) return j + 1;
    } else if (!/[\w$\s,.?]/.test(c)) return i;
  }
  return i;
}

function classify(
  source: Source,
  r: RelationFact,
  target: string,
  enclosing: SymbolFact | undefined,
): { kind: RelationKind; confidence: 'precise' | 'inferred' } {
  const src = source.text;
  const start = offsetOf(source, r.from.range.startLine, r.from.range.startColumn);
  const end = offsetOf(source, r.from.range.endLine, r.from.range.endColumn);

  // 상속·구현: 감싸는 타입의 머리(이름 뒤 '{' 앞)에 있고, scip-dart가 그 타입의 조상으로 알려 준 것만.
  if (enclosing?.supertypes?.includes(target)) {
    const nameEnd = offsetOf(source, enclosing.range.endLine, enclosing.range.endColumn);
    const bodyAt = src.slice(nameEnd).search(/[{;]/);
    if (start >= nameEnd && (bodyAt < 0 || start < nameEnd + bodyAt)) {
      const keyword = [...src.slice(nameEnd, start).matchAll(/(?<![\w$])(extends|with|implements|on)(?![\w$])/g)].at(-1)?.[1];
      if (keyword) return { kind: keyword === 'implements' || keyword === 'on' ? 'implements' : 'extends', confidence: 'precise' };
    }
  }

  const suffix = parseSymbol(target).descriptors.at(-1)?.suffix;
  let after = skipSpace(src, end);
  if (src[after] === '<') after = skipSpace(src, skipTypeArgs(src, after));
  if (src[after] === '(') return { kind: 'call', confidence: 'inferred' };
  if (suffix === 'term' || suffix === 'method') {
    const before = src.slice(Math.max(0, start - 3), start).trimEnd();
    if (ASSIGN_AFTER.test(src.slice(after, after + 4)) || before.endsWith('++') || before.endsWith('--')) {
      return { kind: 'write', confidence: 'inferred' };
    }
    return { kind: 'read', confidence: 'inferred' };
  }
  return { kind: 'reference', confidence: 'inferred' };
}
