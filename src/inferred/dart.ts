// Dart 추정 규칙: tree-sitter-dart 구문 나무에서 정의, 사용처, import를 뽑아요.
// 이름 잇기는 추정 층(layer.ts)이 해요. 파일 고르기(생성된 코드, 테스트)는 정밀 어댑터와 같은 Dart 관례를 써요.
import { posix } from 'node:path';
import { dartRole, isGeneratedDart } from '../adapters/dart-conventions.ts';
import type { Range, RelationKind, SymbolKind } from '../facts.ts';
import { perRepo, type FileSyntax, type InferredLanguage, type RepoView } from './layer.ts';
import { isCodeIdentifierIn, namedChildren, rangeOf, same, type CodeIdentifierNodes, type SyntaxNode } from './tree-sitter.ts';

const spanOf = (a: SyntaxNode, b: SyntaxNode): Range => ({ ...rangeOf(a), endLine: b.endPosition.row, endColumn: b.endPosition.column });

/** 선언 앞에 올 수 있는 타입 표기 노드(최상위 변수 선언의 const를 찾을 때 건너뛰어요). */
const TYPE_NODES = new Set(['type_identifier', 'type_arguments', 'inferred_type', 'nullable_type', 'function_type', 'void_type', 'late_builtin']);
const ASSIGNABLE_SELECTORS = new Set(['unconditional_assignable_selector', 'conditional_assignable_selector']);
const TYPE_DECLARATIONS = new Set(['class_definition', 'mixin_declaration', 'enum_declaration', 'extension_declaration', 'type_alias']);

/** 이름 노드: name 칸, 없으면 처음 나오는 identifier(타입 별칭은 type_identifier). */
function nameNode(n: SyntaxNode): SyntaxNode | null {
  return n.childForFieldName('name') ?? namedChildren(n).find((c) => c.type === 'identifier' || c.type === 'type_identifier') ?? null;
}

/** 한 파일을 읽는 동안의 상태. */
class Extractor {
  readonly out: FileSyntax = { definitions: [], references: [], imports: [] };
  /** 정의의 이름 노드와 지역 선언의 이름 노드(사용처로 세지 않아요). 시작 위치로 가려요. */
  private readonly declared = new Set<number>();

  define(name: SyntaxNode, kind: SymbolKind, enclosing: Range, parent: number | undefined): number {
    this.declared.add(name.startIndex);
    this.out.definitions.push({ name: name.text, kind, range: rangeOf(name), enclosingRange: enclosing, ...(parent !== undefined ? { parent } : {}) });
    return this.out.definitions.length - 1;
  }

  /** 프로그램, 클래스 본문 등 선언이 늘어선 곳. parent는 그 선언들의 바깥 정의. */
  members(container: SyntaxNode, parent: number | undefined): void {
    const items = namedChildren(container);
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!;
      const next = items[i + 1];
      const body = next?.type === 'function_body' ? next : undefined;
      if (body) i++;
      switch (c.type) {
        case 'import_or_export':
        case 'part_directive':
        case 'part_of_directive':
          this.directive(c);
          break;
        case 'function_signature':
          this.callable(c, body, parent === undefined ? 'function' : 'method', parent);
          break;
        case 'method_signature':
          this.signature(namedChildren(c)[0] ?? c, c, body, parent);
          break;
        case 'declaration':
          this.declaration(c, parent);
          break;
        case 'static_final_declaration_list':
        case 'initialized_identifier_list':
          this.variables(c, parent, this.constBefore(items, i) ? 'constant' : parent === undefined ? 'variable' : 'field');
          break;
        case 'enum_constant': {
          const name = nameNode(c);
          if (name) this.define(name, 'field', rangeOf(c), parent);
          break;
        }
        default:
          if (TYPE_DECLARATIONS.has(c.type)) this.type(c, parent);
          else this.refs(c, parent, new Set());
      }
    }
  }

  /** 최상위 변수 선언 앞(타입 표기를 건너뛰어)에 const가 있는지. */
  private constBefore(items: SyntaxNode[], i: number): boolean {
    for (let j = i - 1; j >= 0; j--) {
      const t = items[j]!.type;
      if (t === 'const_builtin') return true;
      if (!TYPE_NODES.has(t) && t !== 'final_builtin') return false;
    }
    return false;
  }

  private type(n: SyntaxNode, parent: number | undefined): void {
    // 이름 없는 extension(`extension on String`)은 정의를 만들지 않아요(on 뒤의 타입을 이름으로 잡지 않게).
    const name = n.type === 'extension_declaration' ? (namedChildren(n).find((c) => c.type === 'identifier') ?? null) : nameNode(n);
    const kinds: Record<string, SymbolKind> = {
      class_definition: 'class',
      mixin_declaration: 'mixin',
      enum_declaration: 'enum',
      extension_declaration: 'extension',
      type_alias: 'type',
    };
    let kind = kinds[n.type]!;
    const tokens = namedChildren(n).map((c) => c.type);
    if (kind === 'class' && tokens.includes('abstract') && tokens.includes('interface')) kind = 'interface';
    const self = name ? this.define(name, kind, rangeOf(n), parent) : parent;
    for (const c of namedChildren(n)) {
      if (same(c, name)) continue;
      if (c.type === 'class_body' || c.type === 'enum_body' || c.type === 'extension_body') this.members(c, self);
      else if (c.type === 'superclass') {
        for (const s of namedChildren(c)) {
          if (s.type === 'mixins') for (const m of namedChildren(s)) this.typeRef(m, 'extends', self);
          else this.typeRef(s, 'extends', self);
        }
      } else if (c.type === 'interfaces') for (const s of namedChildren(c)) this.typeRef(s, 'implements', self);
      else if (n.type === 'mixin_declaration' && c.type === 'type_identifier') this.typeRef(c, 'implements', self);
      else this.refs(c, self, new Set());
    }
  }

  /** 상속·구현 절의 타입 하나. 타입 인자 안의 타입은 그냥 언급이에요. */
  private typeRef(n: SyntaxNode, kind: RelationKind, at: number | undefined): void {
    if (n.type === 'type_identifier') this.ref(n, kind, at);
    else this.refs(n, at, new Set());
  }

  /** method_signature 안의 실제 시그니처. */
  private signature(sig: SyntaxNode, whole: SyntaxNode, body: SyntaxNode | undefined, parent: number | undefined): void {
    switch (sig.type) {
      case 'function_signature':
        return this.callable(sig, body, 'method', parent, whole);
      case 'getter_signature':
        return this.callable(sig, body, 'getter', parent, whole);
      case 'setter_signature':
        return this.callable(sig, body, 'setter', parent, whole);
      case 'constructor_signature':
      case 'constant_constructor_signature':
      case 'factory_constructor_signature':
      case 'redirecting_factory_constructor_signature':
        return this.ctor(sig, body, parent, whole);
      default:
        this.refs(whole, parent, new Set());
        if (body) this.refs(body, parent, new Set());
    }
  }

  /** class 본문의 declaration: 추상 메서드, 생성자, 필드. */
  private declaration(n: SyntaxNode, parent: number | undefined): void {
    const parts = namedChildren(n);
    const isConst = parts.some((c) => c.type === 'const_builtin');
    for (const c of parts) {
      if (c.type === 'static_final_declaration_list' || c.type === 'initialized_identifier_list') {
        this.variables(c, parent, isConst ? 'constant' : parent === undefined ? 'variable' : 'field');
      } else if (c.type === 'initializers' || c.type === 'redirection') {
        // 생성자 뒤의 초기화 목록은 그 생성자(이름 없는 생성자면 클래스)에 속해요. 아래 ctor가 함께 읽어요.
      } else if (['function_signature', 'getter_signature', 'setter_signature', 'constructor_signature', 'constant_constructor_signature', 'factory_constructor_signature', 'redirecting_factory_constructor_signature'].includes(c.type)) {
        const rest = parts.filter((p) => p.type === 'initializers' || p.type === 'redirection');
        if (c.type.includes('constructor')) this.ctor(c, undefined, parent, n, rest);
        else this.signature(c, n, undefined, parent);
      } else this.refs(c, parent, new Set());
    }
  }

  private callable(sig: SyntaxNode, body: SyntaxNode | undefined, kind: SymbolKind, parent: number | undefined, whole: SyntaxNode = sig): void {
    const name = nameNode(sig);
    if (!name) return;
    const self = this.define(name, kind, spanOf(whole, body ?? whole), parent);
    const locals = new Set<string>();
    this.collectLocals(sig, locals);
    if (body) this.collectLocals(body, locals);
    this.refs(sig, self, locals);
    if (body) this.refs(body, self, locals);
  }

  /**
   * 생성자. 이름 없는 생성자(`Cart(...)`)는 정의를 따로 만들지 않고 클래스에 속해요(정밀 어댑터가 클래스로 합치는 것과 같아요).
   * 이름 있는 생성자(`Cart.empty`)는 constructor 정의예요.
   */
  private ctor(sig: SyntaxNode, body: SyntaxNode | undefined, parent: number | undefined, whole: SyntaxNode, extra: SyntaxNode[] = []): void {
    const ids = namedChildren(sig).filter((c) => c.type === 'identifier');
    for (const id of ids) this.declared.add(id.startIndex);
    const named = ids.length >= 2 ? ids[1]! : undefined;
    const self = named ? this.define(named, 'constructor', spanOf(whole, body ?? whole), parent) : parent;
    const locals = new Set<string>();
    for (const n of [sig, ...extra, ...(body ? [body] : [])]) this.collectLocals(n, locals);
    for (const n of [sig, ...extra, ...(body ? [body] : [])]) this.refs(n, self, locals);
  }

  private variables(list: SyntaxNode, parent: number | undefined, kind: SymbolKind): void {
    for (const item of namedChildren(list)) {
      const name = nameNode(item);
      if (!name) continue;
      const self = this.define(name, kind, rangeOf(item), parent);
      const locals = new Set<string>();
      this.collectLocals(item, locals);
      this.refs(item, self, locals);
    }
  }

  /** import, export, part, part of. */
  private directive(n: SyntaxNode): void {
    const literal = n.descendantsOfType('string_literal')[0];
    if (!literal) return;
    const spec = literal.text.replace(/^(r)?(['"]{1,3})([\s\S]*)\2$/, '$3');
    const range = rangeOf(literal);
    if (n.type === 'part_directive') this.out.imports.push({ spec, range, reexport: true, emit: true });
    else if (n.type === 'part_of_directive') this.out.imports.push({ spec, range, reexport: false, emit: false, sharesScope: true });
    else {
      const reexport = namedChildren(n).some((c) => c.type === 'library_export');
      this.out.imports.push({ spec, range, reexport, emit: true });
    }
    // show/hide 뒤의 이름은 사용처로 세지 않아요.
  }

  /** 본문 안에서 선언되는 지역 이름(매개변수, 지역 변수, 반복 변수, catch 변수). 그 이름의 노드는 사용처로 세지 않아요. */
  private collectLocals(n: SyntaxNode, into: Set<string>): void {
    const add = (id: SyntaxNode | null | undefined) => {
      if (!id || id.type !== 'identifier') return;
      into.add(id.text);
      this.declared.add(id.startIndex);
    };
    const visit = (x: SyntaxNode) => {
      switch (x.type) {
        case 'formal_parameter': {
          // this.x / super.x 매개변수는 필드를 가리켜요(지역 이름이 아니에요).
          if (!namedChildren(x).some((c) => c.type === 'constructor_param' || c.type === 'super_formal_parameter')) {
            add(x.childForFieldName('name') ?? namedChildren(x).filter((c) => c.type === 'identifier').at(-1));
          }
          break;
        }
        case 'initialized_variable_definition':
          add(x.childForFieldName('name'));
          break;
        case 'catch_parameters':
          for (const c of namedChildren(x)) add(c);
          break;
        case 'for_loop_parts': {
          const parts = namedChildren(x);
          const first = parts.findIndex((c) => c.type === 'identifier');
          if (first > 0 && !x.childForFieldName('init')) add(parts[first]);
          break;
        }
      }
      for (const c of namedChildren(x)) if (!TYPE_DECLARATIONS.has(c.type)) visit(c);
    };
    visit(n);
  }

  /** 앞 문서 주석 줄이 연 코드 묶음(```) 안인지와 그 줄. `///` 줄은 줄마다 노드라 묶음이 노드를 넘어 이어져요. */
  private fence = { open: false, lastRow: -2 };

  /**
   * 문서 주석(`///`, `/** … *\/`)의 dartdoc 링크 `[name]`, `[Type.member]`. 사용처로 내되 doc 표시를 붙여요.
   * 코드 조각(`` `[x]` ``, ``` 묶음)과 마크다운 링크(`[글](주소)`, `[글][참조]`, `[참조]: 주소`)는 링크가 아니에요.
   * `[a.b.c]`처럼 점이 둘 이상이면 앞은 import 접두사로 보고 마지막 둘(타입, 멤버)만 봐요.
   */
  private docLinks(n: SyntaxNode, at: number | undefined): void {
    if (n.startPosition.row !== this.fence.lastRow + 1) this.fence.open = false;
    this.fence.lastRow = n.endPosition.row;
    const lines = n.text.split('\n');
    lines.forEach((raw, i) => {
      const row = n.startPosition.row + i;
      const base = i === 0 ? n.startPosition.column : 0;
      const body = raw.replace(/^\s*(\/\/\/|\/\*\*|\*(?!\/))?\s?/, '');
      if (body.startsWith('```')) {
        this.fence.open = !this.fence.open;
        return;
      }
      if (this.fence.open) return;
      // 코드 조각은 같은 길이의 공백으로 지워 열 위치를 지켜요.
      const text = raw.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
      for (const m of text.matchAll(/\[([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\](?![(\[:])/g)) {
        const parts = m[1]!.split('.');
        const tail = parts.slice(-2);
        let column = base + m.index + 1 + m[1]!.length - tail.join('.').length;
        const ref = (name: string, member?: { qualifier?: string }) => {
          const range = { startLine: row, startColumn: column, endLine: row, endColumn: column + name.length };
          this.out.references.push({ name, range, kind: 'reference', doc: true, ...(at !== undefined ? { in: at } : {}), ...(member ? { member } : {}) });
          column += name.length + 1;
        };
        if (tail.length === 1) ref(tail[0]!);
        else {
          ref(tail[0]!);
          ref(tail[1]!, { qualifier: tail[0]! });
        }
      }
    });
  }

  /** 노드 안의 사용처를 모두 모아요. at은 감싸는 정의, locals는 지역 이름. */
  refs(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    if (n.type === 'identifier' || n.type === 'type_identifier') {
      this.name(n, at, locals);
      return;
    }
    if (n.type === 'documentation_comment') return this.docLinks(n, at);
    if (n.type === 'label' || n.type === 'comment') return;
    if (n.type === 'import_or_export') return this.directive(n);
    for (const c of namedChildren(n)) this.refs(c, at, locals);
  }

  private name(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    if (this.declared.has(n.startIndex)) return;
    const parent = n.parent;
    if (!parent || parent.type === 'type_parameter') return;
    if (n.type === 'type_identifier') {
      const made = parent.type === 'new_expression' || parent.type === 'const_object_expression';
      this.ref(n, made ? 'call' : 'reference', at);
      return;
    }
    // 수신자.이름
    if (ASSIGNABLE_SELECTORS.has(parent.type) || parent.type === 'cascade_selector') {
      const link = parent.parent?.type === 'selector' ? parent.parent : parent;
      const before = parent.type === 'cascade_selector' ? null : link.previousNamedSibling;
      const kind = this.memberKind(n, parent, link);
      if (before?.type === 'this') return this.ref(n, kind, at);
      const qualifier = before?.type === 'identifier' ? before.text : undefined;
      this.ref(n, kind, at, { ...(qualifier !== undefined ? { qualifier } : {}) });
      return;
    }
    if (locals.has(n.text)) return;
    let kind: RelationKind = 'read';
    if (isCallFollows(n)) kind = 'call';
    else if (parent.type === 'assignable_expression' && same(namedChildren(parent).at(-1), n) && isWritten(parent)) kind = 'write';
    this.ref(n, kind, at);
  }

  private memberKind(n: SyntaxNode, selector: SyntaxNode, link: SyntaxNode): RelationKind {
    if (selector.type === 'cascade_selector') {
      const section = selector.parent;
      const next = selector.nextNamedSibling;
      if (next?.type === 'argument_part') return 'call';
      if (section?.children.some((c) => c !== null && !c.isNamed && /^(=|[-+*/%&|^~?<>]+=)$/.test(c.type))) return 'write';
      return 'read';
    }
    if (isCallFollows(link)) return 'call';
    const assignable = link.parent;
    if (same(link, selector) && assignable?.type === 'assignable_expression' && same(namedChildren(assignable).at(-1), selector) && isWritten(assignable)) return 'write';
    return n.type === 'identifier' ? 'read' : 'reference';
  }

  ref(n: SyntaxNode, kind: RelationKind, at: number | undefined, member?: { qualifier?: string }): void {
    this.out.references.push({ name: n.text, range: rangeOf(n), kind, ...(at !== undefined ? { in: at } : {}), ...(member ? { member } : {}) });
  }
}

/** 이 노드 바로 뒤가 인자 목록이면(타입 인자 포함) 부르는 곳이에요. */
function isCallFollows(n: SyntaxNode): boolean {
  const next = n.nextNamedSibling;
  return next?.type === 'selector' && namedChildren(next)[0]?.type === 'argument_part';
}

/** assignable_expression이 쓰기 자리(대입의 왼쪽, ++/--)인지. */
function isWritten(assignable: SyntaxNode): boolean {
  const p = assignable.parent;
  if (!p) return false;
  if (p.type === 'assignment_expression') return same(namedChildren(p)[0], assignable);
  if (p.type === 'postfix_expression') return true;
  if (p.type === 'unary_expression') return namedChildren(p).some((c) => c.type === 'increment_operator');
  return false;
}

/** pubspec.yaml이 있는 폴더(패키지 뿌리)와 패키지 이름. */
interface DartPackage {
  dir: string;
  name: string | null;
}

const packages = perRepo((repo): DartPackage[] =>
  [...repo.files]
    .filter((f) => f === 'pubspec.yaml' || f.endsWith('/pubspec.yaml'))
    .map((f) => {
      const dir = f.slice(0, -'pubspec.yaml'.length).replace(/\/$/, '');
      const name = /^name:\s*([\w]+)/m.exec(repo.read(f) ?? '')?.[1] ?? null;
      return { dir, name };
    })
    .sort((a, b) => b.dir.length - a.dir.length), // 깊은 것부터: 가장 가까운 패키지를 먼저 찾아요.
);

/** 파일이 든 가장 가까운 패키지 뿌리 기준 경로. 패키지 밖이면 저장소 뿌리 기준. */
function inPackage(path: string, repo: RepoView): string {
  const pkg = packages(repo).find((p) => p.dir === '' || path.startsWith(`${p.dir}/`));
  return pkg && pkg.dir ? path.slice(pkg.dir.length + 1) : path;
}

/** tree-sitter-dart의 식별자, 글·주석, 글에 끼운 식(`$x`, `${x}`) 노드. */
const DART_NODES: CodeIdentifierNodes = {
  identifier: (type) => type.includes('identifier'),
  text: new Set(['string_literal', 'comment', 'documentation_comment']),
  embedded: new Set(['template_substitution']),
};

export const dartInferred: InferredLanguage = {
  language: 'dart',
  grammar: 'dart',
  isCodeIdentifier: (node) => isCodeIdentifierIn(node, DART_NODES),
  owns: (path) => path.endsWith('.dart'),
  excluded: (path, text, repo) => isGeneratedDart(inPackage(path, repo), text),
  role: (path, repo) => dartRole(inPackage(path, repo)),
  extract(root) {
    const x = new Extractor();
    x.members(root, undefined);
    return x.out;
  },
  resolveImport(fromPath, spec, repo) {
    if (spec.startsWith('dart:')) return null;
    const pkg = /^package:([\w]+)\/(.+)$/.exec(spec);
    if (pkg) {
      const target = packages(repo).find((p) => p.name === pkg[1]);
      return target ? posix.join(target.dir, 'lib', pkg[2]!) : null;
    }
    if (/^[a-z]+:/.test(spec)) return null;
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    return joined.startsWith('../') ? null : joined;
  },
};

