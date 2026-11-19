// SCIP 색인(index.scip)을 공통 형식의 사실로 옮겨요. 언어와 무관해서
// scip-dart 말고 다른 SCIP 색인기(scip-python, scip-typescript)도 이걸 써요.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { emptyFacts, type Facts, type Range, type RelationFact, type RelationKind, type SymbolFact, type SymbolKind } from '../facts.ts';
import { parseSymbol, symbolNames, type ParsedSymbol } from './symbol.ts';

const protoPath = fileURLToPath(new URL('../../proto/scip.proto', import.meta.url));
const IndexType = protobuf.loadSync(protoPath).lookupType('scip.Index');

// scip.proto의 SymbolRole 비트.
const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;
const ROLE_WRITE = 0x4;
const ROLE_READ = 0x8;

interface ScipOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
  enclosingRange?: number[];
}

interface ScipSymbolInformation {
  symbol?: string;
  kind?: string;
  displayName?: string;
  enclosingSymbol?: string;
}

interface ScipDocument {
  relativePath?: string;
  language?: string;
  occurrences?: ScipOccurrence[];
  symbols?: ScipSymbolInformation[];
}

export interface ScipToFactsOptions {
  /** 관계의 source로 남는 색인기 이름. */
  source: string;
  language: string;
  /** 색인한 패키지가 저장소 뿌리에서 떨어진 경로('' 또는 'packages/foo'). */
  pathPrefix: string;
  /** 색인기가 낸 문자열(경로, 심볼)을 OS와 무관하게 고쳐요. */
  normalize?: (s: string) => string;
}

/** SCIP의 range([줄, 시작열, 끝열] 또는 [시작줄, 시작열, 끝줄, 끝열])를 Range로. */
function toRange(r: number[] | undefined): Range | undefined {
  if (!r || r.length < 3) return undefined;
  if (r.length === 3) return { startLine: r[0]!, startColumn: r[1]!, endLine: r[0]!, endColumn: r[2]! };
  return { startLine: r[0]!, startColumn: r[1]!, endLine: r[2]!, endColumn: r[3]! };
}

function contains(outer: Range, inner: Range): boolean {
  const startsAfter =
    inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn);
  const endsBefore =
    inner.endLine < outer.endLine || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsAfter && endsBefore;
}

/** 범위의 크기. 줄 수를 먼저 견주고, 같으면 열 수로 견줘요(한 줄은 100000열을 넘지 않는다고 봐요). */
function size(r: Range): number {
  return (r.endLine - r.startLine) * 100000 + (r.endColumn - r.startColumn);
}

const KINDS: Record<string, SymbolKind> = {
  Class: 'class',
  Interface: 'interface',
  Enum: 'enum',
  EnumMember: 'constant',
  Mixin: 'mixin',
  Extension: 'extension',
  TypeAlias: 'type',
  Type: 'type',
  Function: 'function',
  Method: 'method',
  StaticMethod: 'method',
  Constructor: 'constructor',
  Getter: 'getter',
  Setter: 'setter',
  Field: 'field',
  StaticField: 'field',
  Property: 'field',
  Variable: 'variable',
  Constant: 'constant',
  Parameter: 'parameter',
  Namespace: 'namespace',
  Package: 'namespace',
  Module: 'namespace',
};

/** 종류를 색인기가 주지 않으면 심볼 문자열의 마지막 꼬리로 짐작해요. */
function kindOf(info: ScipSymbolInformation | undefined, lastSuffix: string | undefined): SymbolKind {
  const k = info?.kind && KINDS[info.kind];
  if (k) return k;
  if (lastSuffix === 'namespace') return 'file';
  if (lastSuffix === 'method') return 'function';
  if (lastSuffix === 'type') return 'type';
  if (lastSuffix === 'term') return 'variable';
  return 'unknown';
}

function relationKind(roles: number): RelationKind {
  if (roles & ROLE_IMPORT) return 'import';
  if (roles & ROLE_WRITE) return 'write';
  if (roles & ROLE_READ) return 'read';
  return 'reference';
}

export function scipToFacts(scipFile: string, opts: ScipToFactsOptions): Facts {
  const norm = opts.normalize ?? ((s: string) => s);
  const decoded = IndexType.toObject(IndexType.decode(readFileSync(scipFile)), {
    enums: String,
    longs: Number,
    defaults: false,
  }) as { documents?: ScipDocument[] };

  const withPrefix = (p: string) => (opts.pathPrefix ? `${opts.pathPrefix}/${p}` : p);
  const facts: Facts = emptyFacts();
  const docs = (decoded.documents ?? []).map((d) => ({ ...d, path: withPrefix(norm(d.relativePath ?? '')) }));

  // 1) 파일과 정의. 정의는 occurrence의 Definition 역할로 찾아요.
  const fileKeys = new Map<string, string>(); // 파일 심볼 → 경로
  const defsByFile = new Map<string, SymbolFact[]>();
  for (const doc of docs) {
    facts.files.push({ path: doc.path, language: opts.language });
    const infos = new Map<string, ScipSymbolInformation>();
    for (const info of doc.symbols ?? []) if (info.symbol) infos.set(norm(info.symbol), info);
    const defs: SymbolFact[] = [];
    for (const occ of doc.occurrences ?? []) {
      if (!occ.symbol || !((occ.symbolRoles ?? 0) & ROLE_DEFINITION)) continue;
      const key = norm(occ.symbol);
      const parsed = parseSymbol(key);
      if (parsed.local) continue;
      const last = parsed.descriptors.at(-1);
      if (last?.suffix === 'namespace') {
        fileKeys.set(key, doc.path);
        continue;
      }
      const names = symbolNames(parsed);
      const range = toRange(occ.range);
      if (!names || !range) continue;
      const info = infos.get(key);
      const parentKey = info?.enclosingSymbol ? norm(info.enclosingSymbol) : parentFromDescriptors(key, parsed);
      defs.push({
        key,
        name: info?.displayName || names.name,
        qualifiedName: names.qualifiedName,
        kind: kindOf(info, last?.suffix),
        path: doc.path,
        range,
        enclosingRange: toRange(occ.enclosingRange),
        parentKey,
        confidence: 'precise',
        source: opts.source,
      });
    }
    defsByFile.set(doc.path, defs);
    facts.symbols.push(...defs);
  }

  // 2) 사용처. 감싸는 정의 중 가장 안쪽 것을 from.symbolKey로 둬요.
  for (const doc of docs) {
    const defs = (defsByFile.get(doc.path) ?? []).filter((d) => d.enclosingRange);
    for (const occ of doc.occurrences ?? []) {
      const roles = occ.symbolRoles ?? 0;
      if (!occ.symbol || roles & ROLE_DEFINITION) continue;
      const key = norm(occ.symbol);
      if (parseSymbol(key).local) continue;
      const range = toRange(occ.range);
      if (!range) continue;
      const enclosing = defs
        .filter((d) => contains(d.enclosingRange!, range))
        .sort((a, b) => size(a.enclosingRange!) - size(b.enclosingRange!))[0];
      // 파일 자체를 가리키는 심볼('…/`lib/a.dart`/')이면 import예요.
      const target = fileKeys.get(key) ?? null;
      const relation: RelationFact = {
        kind: target !== null ? 'import' : relationKind(roles),
        from: { path: doc.path, range, ...(enclosing ? { symbolKey: enclosing.key } : {}) },
        to: target !== null ? { path: target } : { symbolKey: key },
        confidence: 'precise',
        source: opts.source,
      };
      facts.relations.push(relation);
    }
  }
  return facts;
}

/** 심볼 문자열에서 마지막 기술자를 떼어 바깥 심볼의 key를 만들어요(타입 안의 멤버일 때만). */
function parentFromDescriptors(key: string, parsed: ParsedSymbol): string | undefined {
  const parent = parsed.descriptors.at(-2);
  if (!parent || parent.suffix !== 'type') return undefined;
  const idx = key.lastIndexOf('#');
  return idx > 0 ? key.slice(0, idx + 1) : undefined;
}
