// 추정 층: Tree-sitter로 파일의 구문을 읽고(언어 규칙), 이름으로 정의와 사용처를 이어(이 파일) 사실을 내요.
// 여기서 나온 심볼과 관계는 모두 confidence: 'inferred', kindConfidence: 'inferred'예요.
//
// 언어 하나의 추정 어댑터 = 문법 하나 + 작은 규칙(InferredLanguage). 이름 잇기, 파일 고르기, 정밀 사실과 섞기는 여기서 해요.
// 설명은 docs/architecture.md의 "추정 층"에 있어요.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Facts, FileRole, Range, RelationFact, RelationKind, RepoInfo, SymbolFact, SymbolKind } from '../facts.ts';
import { run } from '../run.ts';
import { parserFor, type SyntaxNode } from './tree-sitter.ts';

/** 파일 안의 정의 하나. */
export interface SyntaxDefinition {
  name: string;
  kind: SymbolKind;
  /** 이름이 적힌 자리. */
  range: Range;
  /** 정의 전체(본문 포함). */
  enclosingRange: Range;
  /** 바로 바깥 정의(같은 파일 definitions의 번호). 멤버라면 그 타입이에요. */
  parent?: number;
}

/** 파일 안의 이름 사용 하나. 무엇을 가리키는지는 아직 몰라요(이 층이 이름으로 이어요). */
export interface SyntaxReference {
  name: string;
  range: Range;
  /** 문법으로 가린 관계 종류. 이은 대상이 타입인데 read로 가렸으면 reference로 바꿔요. */
  kind: RelationKind;
  /** 사용처를 감싸는 정의(같은 파일 definitions의 번호). 없으면 파일 최상위예요. */
  in?: number;
  /**
   * `.` 뒤의 이름(수신자.이름)이면 붙여요. 수신자의 타입을 모르니 멤버 가운데서 찾아요.
   * qualifier: 수신자가 이름 하나일 때 그 이름(`Cart.empty`의 Cart). 타입 이름이면 그 타입의 멤버에서 찾아요.
   * `this.x`/`self.x`처럼 자기 자신이면 언어 규칙이 member 없이(감싸는 타입의 멤버부터 찾는 이름으로) 내요.
   */
  member?: { qualifier?: string };
}

/** 파일 안의 import(또는 그와 비슷한 지시문) 하나. */
export interface SyntaxImport {
  /** 적힌 그대로의 대상(예: 'package:a/a.dart', '../b.dart'). 언어 규칙의 resolveImport가 파일로 풀어요. */
  spec: string;
  range: Range;
  /** 가져온 파일의 이름을 이 파일이 다시 내보내는지(Dart export·part). */
  reexport: boolean;
  /** import 관계(파일 → 파일)로 넣을지. 이름 공간만 나누고 기대는 방향이 아닌 지시문(Dart part of)은 false. */
  emit: boolean;
  /** 가져온 파일과 이름 공간을 함께 쓰는지(Dart part of: 그 라이브러리가 보는 이름을 모두 봐요). */
  sharesScope?: boolean;
}

export interface FileSyntax {
  definitions: SyntaxDefinition[];
  references: SyntaxReference[];
  imports: SyntaxImport[];
}

/** 언어 규칙이 저장소를 들여다보는 창. */
export interface RepoView {
  root: string;
  /** 저장소의 파일(무시된 파일 제외, '/' 구분). */
  files: ReadonlySet<string>;
  /** 저장소 기준 경로의 글. 없으면 null. */
  read(path: string): string | null;
}

/** 언어 하나의 추정 규칙. 새 언어는 이것 하나를 만들어 src/languages.ts에 올려요. */
export interface InferredLanguage {
  /** 예: 'dart'. 정밀 어댑터의 language와 같아야 그 언어의 정밀 사실과 섞여요. */
  readonly language: string;
  /** `@repomix/tree-sitter-wasms`의 문법 이름(예: 'dart'). 파일마다 다르면 grammarFor를 줘요. */
  readonly grammar: string;
  /** 파일마다 문법이 다를 때(예: .tsx). 없으면 grammar. */
  grammarFor?(path: string): string;
  /** 이 언어의 파일인지(보통 확장자). */
  owns(path: string): boolean;
  /** 색인에서 뺄 파일인지(생성된 코드, 빌드 산출물). text는 파일 글. */
  excluded(path: string, text: string, repo: RepoView): boolean;
  /** 파일의 역할(테스트 파일인지). */
  role(path: string, repo: RepoView): FileRole;
  /** 구문 나무에서 정의, 사용처, import를 뽑아요. */
  extract(root: SyntaxNode, text: string): FileSyntax;
  /** import의 대상을 저장소 안 파일 경로로 풀어요. 저장소 밖(SDK, 패키지)이면 null. */
  resolveImport(fromPath: string, spec: string, repo: RepoView): string | null;
}

/** 추정 층이 내는 사실의 출처 이름. 예: tree-sitter-dart */
export const inferredSource = (lang: InferredLanguage) => `tree-sitter-${lang.language}`;

export interface InferredRun {
  /** 사실을 낼 파일(정밀 색인이 덮지 못한 파일). 이 밖의 파일은 읽기만 하고(이름 잇기용) 사실을 내지 않아요. */
  emit: (path: string) => boolean;
  /** 같은 언어의 정밀 사실. 사실을 내지 않는 파일의 정의는 같은 자리의 정밀 심볼 열쇠로 이어요. */
  precise: Facts;
}

const TYPE_KINDS = new Set<SymbolKind>(['class', 'interface', 'enum', 'mixin', 'extension', 'type']);

/** 저장소에서 이 언어의 파일을 모두 골라요(git이 무시하는 파일 빼고, 추적하지 않는 새 파일 포함). */
export function listRepoFiles(repo: RepoInfo): Set<string> {
  if (repo.trackedFiles !== null) {
    const r = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repo.root);
    if (r.ok) return new Set(r.stdout.split('\0').filter(Boolean));
  }
  const out = new Set<string>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, path);
      else out.add(path);
    }
  };
  walk(repo.root, '');
  return out;
}

export function repoView(repo: RepoInfo, files: Set<string>): RepoView {
  return {
    root: repo.root,
    files,
    read: (path) => {
      try {
        return readFileSync(join(repo.root, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

interface ParsedFile {
  path: string;
  syntax: FileSyntax;
  /** definitions와 같은 순서의 열쇠. 이을 수 없는 정의(사실을 내지 않는 파일에서 정밀 심볼을 못 찾은 것)는 null. */
  keys: (string | null)[];
  /** definitions와 같은 순서의 바깥 타입을 붙인 이름. */
  qualified: string[];
  emit: boolean;
  role: FileRole;
  /** 풀린 import(대상 파일이 이 언어로 읽힌 것만). */
  imports: { syntax: SyntaxImport; target: string | null }[];
}

/** 이 언어의 파일을 모두 읽고 이름으로 이어, emit에 든 파일의 사실을 내요. */
export async function runInferred(lang: InferredLanguage, repo: RepoInfo, opts: InferredRun): Promise<Facts> {
  const source = inferredSource(lang);
  const files = listRepoFiles(repo);
  const view = repoView(repo, files);
  const preciseAt = new Map<string, string>();
  for (const s of opts.precise.symbols) preciseAt.set(`${s.path}:${s.range.startLine}:${s.range.startColumn}`, s.key);

  // 1) 읽기: 이 언어의 파일마다 구문을 뽑아요.
  const parsed = new Map<string, ParsedFile>();
  for (const path of [...files].filter((p) => lang.owns(p)).sort()) {
    const text = view.read(path);
    if (text === null || lang.excluded(path, text, view)) continue;
    const parser = await parserFor(lang.grammarFor?.(path) ?? lang.grammar);
    const tree = parser.parse(text);
    parser.delete();
    if (!tree) continue;
    const syntax = lang.extract(tree.rootNode, text);
    tree.delete();
    const emit = opts.emit(path);
    const qualified = syntax.definitions.map((_, i) => qualifiedName(syntax.definitions, i));
    const keys = syntax.definitions.map((d, i) =>
      emit ? null : (preciseAt.get(`${path}:${d.range.startLine}:${d.range.startColumn}`) ?? null),
    );
    if (emit) assignKeys(source, path, syntax.definitions, keys);
    parsed.set(path, { path, syntax, keys, qualified, emit, role: lang.role(path, view), imports: [] });
  }
  for (const f of parsed.values()) {
    f.imports = f.syntax.imports.map((imp) => {
      const target = lang.resolveImport(f.path, imp.spec, view);
      return { syntax: imp, target: target !== null && parsed.has(target) ? target : null };
    });
  }

  // 2) 이름 찾기 표
  const visible = visibleFiles(parsed);
  const membersByName = new Map<string, { file: ParsedFile; index: number }[]>();
  for (const f of parsed.values()) {
    f.syntax.definitions.forEach((d, index) => {
      if (d.parent === undefined || f.keys[index] === null) return;
      const list = membersByName.get(d.name) ?? [];
      list.push({ file: f, index });
      membersByName.set(d.name, list);
    });
  }

  // 3) 사실 내기
  const facts: Facts = { files: [], symbols: [], relations: [] };
  for (const f of parsed.values()) {
    if (!f.emit) continue;
    facts.files.push({ path: f.path, language: lang.language, role: f.role });
    f.syntax.definitions.forEach((d, i) => {
      facts.symbols.push({
        key: f.keys[i]!,
        name: d.name,
        qualifiedName: f.qualified[i]!,
        kind: d.kind,
        path: f.path,
        range: d.range,
        enclosingRange: d.enclosingRange,
        ...(d.parent !== undefined ? { parentKey: f.keys[d.parent]! } : {}),
        confidence: 'inferred',
        source,
      } satisfies SymbolFact);
    });
    for (const imp of f.imports) {
      if (!imp.syntax.emit || imp.target === null) continue;
      facts.relations.push(relation('import', { path: f.path, range: imp.syntax.range }, { path: imp.target }, source));
    }
    const seeing = visible.get(f.path)!;
    for (const ref of f.syntax.references) {
      const target = resolve(f, ref, seeing, parsed, membersByName);
      if (!target) continue;
      const def = target.file.syntax.definitions[target.index]!;
      const kind = ref.kind === 'read' && TYPE_KINDS.has(def.kind) ? 'reference' : ref.kind;
      const from = { path: f.path, range: ref.range, ...(ref.in !== undefined ? { symbolKey: f.keys[ref.in]! } : {}) };
      facts.relations.push(relation(kind, from, { symbolKey: target.file.keys[target.index]! }, source));
    }
  }
  return facts;
}

function relation(kind: RelationKind, from: RelationFact['from'], to: RelationFact['to'], source: string): RelationFact {
  return { kind, from, to, confidence: 'inferred', kindConfidence: 'inferred', source };
}

/** 바깥 정의 이름을 점으로 이은 이름(예: Cart.add). */
function qualifiedName(defs: SyntaxDefinition[], i: number): string {
  const names: string[] = [];
  for (let at: number | undefined = i; at !== undefined; at = defs[at]!.parent) names.unshift(defs[at]!.name);
  return names.join('.');
}

/** 기술자 꼬리: 타입은 '#', 부르는 것은 '().', 값은 '.'(SCIP 심볼과 비슷한 꼴). */
function descriptor(d: SyntaxDefinition): string {
  if (TYPE_KINDS.has(d.kind)) return `${d.name}#`;
  if (d.kind === 'function' || d.kind === 'method' || d.kind === 'constructor') return `${d.name}().`;
  return `${d.name}.`;
}

/**
 * 추정 심볼 열쇠: `<출처> <경로> <바깥 정의부터의 기술자>`. 예: 'tree-sitter-dart lib/src/cart.dart Cart#add().'
 * 경로와 이름에서만 나와서 OS와 무관하고, 다시 색인해도 같아요. 같은 열쇠가 또 나오면(getter와 setter 등) 뒤에 '~2'를 붙여요.
 */
function assignKeys(source: string, path: string, defs: SyntaxDefinition[], keys: (string | null)[]): void {
  const used = new Map<string, number>();
  const chain = (i: number): string => {
    const d = defs[i]!;
    return (d.parent !== undefined ? chain(d.parent) : '') + descriptor(d);
  };
  defs.forEach((_, i) => {
    const base = `${source} ${path} ${chain(i)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    keys[i] = n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * 파일마다 최상위 이름이 보이는 파일들: 자기 자신, 가져온 파일과 그 파일이 다시 내보내는 파일(이어서),
 * 이름 공간을 함께 쓰는 파일(sharesScope)이 보는 파일.
 */
function visibleFiles(parsed: Map<string, ParsedFile>): Map<string, Set<string>> {
  const exported = new Map<string, Set<string>>();
  const exportsOf = (path: string): Set<string> => {
    let out = exported.get(path);
    if (out) return out;
    out = new Set([path]);
    exported.set(path, out);
    for (const imp of parsed.get(path)?.imports ?? []) {
      if (imp.syntax.reexport && imp.target !== null) for (const p of exportsOf(imp.target)) out.add(p);
    }
    return out;
  };
  const own = (path: string): Set<string> => {
    const out = new Set(exportsOf(path));
    for (const imp of parsed.get(path)!.imports) {
      if (imp.target !== null && !imp.syntax.sharesScope) for (const p of exportsOf(imp.target)) out.add(p);
    }
    return out;
  };
  const result = new Map<string, Set<string>>();
  for (const path of parsed.keys()) result.set(path, own(path));
  for (const f of parsed.values()) {
    for (const imp of f.imports) {
      if (imp.syntax.sharesScope && imp.target !== null) for (const p of own(imp.target)) result.get(f.path)!.add(p);
    }
  }
  return result;
}

type Found = { file: ParsedFile; index: number };

/** 하나뿐이면 그것, 아니면(없거나 여럿) null. 여럿 가운데 하나를 고르지 않아요: 다른 같은 이름일 수 있어서요. */
const only = (list: Found[]): Found | null => (list.length === 1 ? list[0]! : null);

/**
 * 사용처 하나가 가리키는 정의를 이름으로 찾아요.
 * - 이름: 감싸는 타입들의 멤버 → 보이는 파일의 최상위 정의.
 * - 멤버(`.이름`): 수신자가 타입 이름이면 그 타입의 멤버. 아니면 같은 이름 멤버가 저장소에 하나뿐일 때, 그다음 보이는 파일에 하나뿐일 때.
 */
function resolve(
  f: ParsedFile,
  ref: SyntaxReference,
  seeing: Set<string>,
  parsed: Map<string, ParsedFile>,
  membersByName: Map<string, Found[]>,
): Found | null {
  const linkable = (x: Found) => x.file.keys[x.index] !== null;
  const membersOf = (owner: Found, name: string): Found[] =>
    owner.file.syntax.definitions.flatMap((d, index) => (d.parent === owner.index && d.name === name ? [{ file: owner.file, index }] : [])).filter(linkable);
  const topLevel = (name: string): Found[] => {
    const out: Found[] = [];
    for (const path of seeing) {
      const file = parsed.get(path)!;
      file.syntax.definitions.forEach((d, index) => {
        if (d.parent === undefined && d.name === name) out.push({ file, index });
      });
    }
    return out.filter(linkable);
  };
  const bare = (name: string, at: number | undefined): Found | null => {
    for (let i = at; i !== undefined; i = f.syntax.definitions[i]!.parent) {
      if (!TYPE_KINDS.has(f.syntax.definitions[i]!.kind)) continue;
      const hit = only(membersOf({ file: f, index: i }, name));
      if (hit) return hit;
    }
    return only(topLevel(name));
  };

  if (!ref.member) return bare(ref.name, ref.in);
  if (ref.member.qualifier !== undefined) {
    const owner = bare(ref.member.qualifier, ref.in);
    if (owner && TYPE_KINDS.has(owner.file.syntax.definitions[owner.index]!.kind)) {
      const hit = only(membersOf(owner, ref.name));
      if (hit) return hit;
    }
  }
  const all = membersByName.get(ref.name) ?? [];
  return only(all) ?? only(all.filter((x) => seeing.has(x.file.path)));
}
