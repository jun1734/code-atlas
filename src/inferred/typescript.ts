// JavaScript/TypeScript 추정 규칙: tree-sitter-typescript·tsx·javascript 구문 나무에서 정의, 사용처, import를 뽑아요.
// 이름 잇기는 추정 층(layer.ts)이 해요. 파일 고르기(생성된 코드, 테스트)는 정밀 어댑터와 같은 관례를 써요.
// 정밀 어댑터(src/adapters/typescript-refine.ts)도 이 추출기로 사용처의 종류(읽기, 쓰기, 호출 …)를 가려요.
import { posix } from 'node:path';
import {
  isGeneratedJsTs,
  isJsTsFile,
  jsTsGrammar,
  jsTsLanguage,
  jsTsRole,
  packageRootsOf,
} from '../adapters/typescript-conventions.ts';
import type { Range, RelationKind, SymbolKind } from '../facts.ts';
import { perRepo, type FileSyntax, type InferredLanguage, type RepoView } from './layer.ts';
import { namedChildren, rangeOf, same, type SyntaxNode } from './tree-sitter.ts';

/** JS/TS 파일의 구문. FileSyntax에 더해, 이름을 가져오거나 내보내기만 하는 자리(bindings)를 알려 줘요. */
export interface JsTsSyntax extends FileSyntax {
  /**
   * 사용처가 아닌 이름 자리: import의 이름, require를 구조 분해한 이름, export 목록(`export { a }`, `module.exports = { a }`).
   * 정밀 어댑터가 scip-typescript의 occurrence 가운데 이 자리의 것을 빼요(Dart의 show/hide 이름처럼 사용처로 세지 않아요).
   */
  bindings: Range[];
}

const FUNCTION_DECLARATIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_signature']);
const CLASS_DECLARATIONS = new Set(['class_declaration', 'abstract_class_declaration']);
const FUNCTION_LIKE = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
/** 이름 붙은 노드 가운데 사용처를 찾지 않는 것(글자, 주석 등). */
const LEAVES = new Set(['comment', 'string_fragment', 'escape_sequence', 'regex', 'number', 'statement_identifier', 'hash_bang_line']);

/** require('x') 또는 import('x')이면 x, 아니면 null. */
function requireSpec(n: SyntaxNode | null | undefined): string | null {
  if (!n || n.type !== 'call_expression') return null;
  const fn = n.childForFieldName('function');
  if (!fn || !((fn.type === 'identifier' && fn.text === 'require') || fn.type === 'import')) return null;
  const arg = namedChildren(n.childForFieldName('arguments') ?? n)[0];
  if (arg?.type !== 'string') return null;
  return stringValue(arg);
}

const stringValue = (s: SyntaxNode) => s.text.slice(1, -1);

/** JSDoc 타입 안에서 저장소의 이름이 아닌 것(기본 타입, 열쇠말). */
const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null', 'void', 'any', 'unknown', 'never',
  'function', 'Function', 'Object', 'Array', 'Promise', 'Record', 'Partial', 'Readonly', 'Map', 'Set', 'Date', 'Error',
  'typeof', 'keyof', 'import', 'true', 'false', 'String', 'Number', 'Boolean',
]);
const isRelative = (spec: string) => spec.startsWith('.') || spec.startsWith('/');

/** 한 파일을 읽는 동안의 상태. */
class Extractor {
  readonly out: JsTsSyntax = { definitions: [], references: [], imports: [], bindings: [] };
  /** 정의의 이름 노드와 지역 선언의 이름 노드(사용처로 세지 않아요). 시작 위치로 가려요. */
  private readonly declared = new Set<number>();
  /** 저장소 안 모듈을 통째로 받은 이름(`import * as p from './p'`, `const p = require('./p')`). `p.x`의 x는 이름 그대로 찾아요. */
  private readonly moduleAliases = new Set<string>();
  /** 저장소 밖 모듈을 통째로 받은 이름(`const path = require('path')`). `path.x`의 x는 잇지 않아요. */
  private readonly externalAliases = new Set<string>();
  /** 파일 최상위 문장 안(블록, if 등)에서 선언된 지역 이름. */
  private readonly fileLocals = new Set<string>();

  program(root: SyntaxNode): void {
    const items = namedChildren(root);
    for (const c of items) this.collectAliases(c);
    for (const c of items) if (!this.isDeclaration(c)) this.collectLocals(c, this.fileLocals);
    for (let i = 0; i < items.length; i++) this.top(items[i]!, undefined, items[i - 1]);
    for (const c of root.descendantsOfType('comment')) if (c && c.text.startsWith('/**')) this.jsdocTypes(c);
  }

  /**
   * JSDoc 타입 표기(`@type {Cart}`, `@param {Provider<T>} p`, `@returns {Cart}` …) 안의 이름은 타입 언급(reference)이에요.
   * JavaScript에서 타입을 적는 방법이에요(scip-typescript는 타입 검사에는 쓰지만 occurrence로 내지 않아요).
   * 감싸는 정의는 주석 바로 뒤에서 시작하는 정의, 없으면 주석을 품는 가장 안쪽 정의예요.
   */
  private jsdocTypes(comment: SyntaxNode): void {
    const text = comment.text;
    const owner = this.ownerOfComment(comment);
    for (const tag of text.matchAll(/@(?:type|param|arg|argument|returns?|typedef|property|prop|template|this|satisfies|enum|throws)\s*\{/g)) {
      let depth = 1;
      let end = tag.index + tag[0].length;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
        end++;
      }
      const start = tag.index + tag[0].length;
      const body = text.slice(start, end - 1);
      for (const m of body.matchAll(/(?<![\w$.'"])[A-Za-z_$][\w$]*(?![\w$])(?!\s*\??:)(?!\s*\()/g)) {
        if (PRIMITIVE_TYPES.has(m[0])) continue;
        const offset = start + m.index;
        const lines = text.slice(0, offset).split('\n');
        const startLine = comment.startPosition.row + lines.length - 1;
        const startColumn = lines.length === 1 ? comment.startPosition.column + offset : lines.at(-1)!.length;
        this.out.references.push({
          name: m[0],
          range: { startLine, startColumn, endLine: startLine, endColumn: startColumn + m[0].length },
          kind: 'reference',
          ...(owner !== undefined ? { in: owner } : {}),
        });
      }
    }
  }

  /** JSDoc 주석이 붙은 정의: 주석이 끝난 줄이나 다음 줄에서 시작하는 정의, 없으면 주석을 품는 가장 안쪽 정의. */
  private ownerOfComment(comment: SyntaxNode): number | undefined {
    const defs = this.out.definitions;
    const end = comment.endPosition.row;
    let next: number | undefined;
    let inner: number | undefined;
    defs.forEach((d, i) => {
      const e = d.enclosingRange;
      if ((e.startLine === end || e.startLine === end + 1) && (e.startLine > comment.startPosition.row || e.startColumn >= comment.endPosition.column)) {
        if (next === undefined || e.startLine < defs[next]!.enclosingRange.startLine) next = i;
      }
      const contains =
        (e.startLine < comment.startPosition.row || (e.startLine === comment.startPosition.row && e.startColumn <= comment.startPosition.column)) &&
        (e.endLine > end || (e.endLine === end && e.endColumn >= comment.endPosition.column));
      if (contains && (inner === undefined || e.startLine >= defs[inner]!.enclosingRange.startLine)) inner = i;
    });
    return next ?? inner;
  }

  private define(name: SyntaxNode, kind: SymbolKind, enclosing: SyntaxNode, parent: number | undefined): number {
    this.declared.add(name.startIndex);
    this.out.definitions.push({
      name: name.text,
      kind,
      range: rangeOf(name),
      enclosingRange: rangeOf(enclosing),
      ...(parent !== undefined ? { parent } : {}),
    });
    return this.out.definitions.length - 1;
  }

  private bind(n: SyntaxNode): void {
    this.declared.add(n.startIndex);
    this.out.bindings.push(rangeOf(n));
  }

  private isDeclaration(n: SyntaxNode): boolean {
    return (
      FUNCTION_DECLARATIONS.has(n.type) ||
      CLASS_DECLARATIONS.has(n.type) ||
      ['interface_declaration', 'type_alias_declaration', 'enum_declaration', 'lexical_declaration', 'variable_declaration',
        'export_statement', 'import_statement', 'ambient_declaration', 'internal_module', 'module'].includes(n.type) ||
      (n.type === 'expression_statement' && namedChildren(n)[0]?.type === 'internal_module')
    );
  }

  /** 모듈을 통째로 받은 이름을 먼저 모아요(뒤의 `p.x`를 가릴 때 써요). */
  private collectAliases(n: SyntaxNode): void {
    if (n.type === 'import_statement') {
      const source = n.childForFieldName('source');
      const ns = n.descendantsOfType('namespace_import')[0];
      const id = ns && namedChildren(ns).find((c) => c.type === 'identifier');
      if (source && id) (isRelative(stringValue(source)) ? this.moduleAliases : this.externalAliases).add(id.text);
      return;
    }
    if (n.type !== 'lexical_declaration' && n.type !== 'variable_declaration') return;
    for (const d of namedChildren(n)) {
      if (d.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      const spec = requireSpec(d.childForFieldName('value'));
      if (spec !== null && name?.type === 'identifier') (isRelative(spec) ? this.moduleAliases : this.externalAliases).add(name.text);
    }
  }

  /** 최상위(또는 namespace 안) 문장 하나. prev는 바로 앞 형제(JSDoc 주석을 찾을 때 써요). */
  private top(n: SyntaxNode, parent: number | undefined, prev: SyntaxNode | undefined): void {
    switch (n.type) {
      case 'comment':
        return;
      case 'import_statement':
        return this.importStatement(n);
      case 'export_statement':
        return this.exportStatement(n, parent, prev);
      case 'ambient_declaration':
        for (const c of namedChildren(n)) this.top(c, parent, prev);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.variables(n, parent);
      case 'interface_declaration':
        return this.interface(n, parent);
      case 'type_alias_declaration': {
        const name = n.childForFieldName('name');
        if (!name) return;
        const self = this.define(name, 'type', n, parent);
        const locals = new Set<string>();
        this.collectLocals(n, locals);
        for (const c of namedChildren(n)) if (!same(c, name)) this.refs(c, self, locals);
        return;
      }
      case 'enum_declaration': {
        const name = n.childForFieldName('name');
        if (!name) return;
        const self = this.define(name, 'enum', n, parent);
        for (const m of namedChildren(n.childForFieldName('body') ?? n)) {
          const id = m.type === 'property_identifier' ? m : m.type === 'enum_assignment' ? m.childForFieldName('name') : null;
          if (id) this.define(id, 'constant', m, self);
          if (m.type === 'enum_assignment') this.refs(m.childForFieldName('value') ?? m, self, new Set());
        }
        return;
      }
      case 'internal_module':
      case 'module': {
        const name = n.childForFieldName('name');
        const self = name && name.type === 'identifier' ? this.define(name, 'namespace', n, parent) : parent;
        const body = n.childForFieldName('body');
        if (body) {
          const items = namedChildren(body);
          items.forEach((c, i) => this.top(c, self, items[i - 1]));
        }
        return;
      }
      case 'expression_statement': {
        const inner = namedChildren(n)[0];
        if (inner?.type === 'internal_module') return this.top(inner, parent, prev);
        if (inner && this.commonJsExport(inner)) return;
        return this.refs(n, parent, this.fileLocals);
      }
      default:
        if (FUNCTION_DECLARATIONS.has(n.type)) return this.callable(n, 'function', parent);
        if (CLASS_DECLARATIONS.has(n.type)) return this.klass(n, parent, prev);
        this.refs(n, parent, this.fileLocals);
    }
  }

  private importStatement(n: SyntaxNode): void {
    const source = n.childForFieldName('source');
    for (const id of [...n.descendantsOfType('identifier'), ...n.descendantsOfType('type_identifier')]) if (id) this.bind(id);
    if (source) this.out.imports.push({ spec: stringValue(source), range: rangeOf(source), reexport: false, emit: true });
    else {
      // import x = require('y') (TypeScript)
      const req = n.descendantsOfType('string')[0];
      if (req) this.out.imports.push({ spec: stringValue(req), range: rangeOf(req), reexport: false, emit: true });
    }
  }

  private exportStatement(n: SyntaxNode, parent: number | undefined, prev: SyntaxNode | undefined): void {
    const source = n.childForFieldName('source');
    if (source) this.out.imports.push({ spec: stringValue(source), range: rangeOf(source), reexport: true, emit: true });
    for (const c of namedChildren(n)) {
      if (same(c, source) || c.type === 'comment') continue;
      if (c.type === 'export_clause' || c.type === 'namespace_export') {
        for (const id of c.descendantsOfType('identifier')) if (id) this.bind(id);
      } else if (c.type === 'identifier' && !source) {
        // export default 이름
        this.bind(c);
      } else if (this.isDeclaration(c) || FUNCTION_DECLARATIONS.has(c.type) || CLASS_DECLARATIONS.has(c.type)) {
        this.top(c, parent, prev);
      } else if ((c.type === 'class' || c.type === 'function_expression' || c.type === 'function') && c.childForFieldName('name')) {
        // export default class X {} / export default function x() {}
        if (c.type === 'class') this.klass(c, parent, prev);
        else this.callable(c, 'function', parent);
      } else this.refs(c, parent, this.fileLocals);
    }
  }

  /**
   * CommonJS 내보내기: `module.exports = …`, `module.exports.x = …`, `exports.x = …`.
   * 내보내는 목록(`{ a, b: c }`의 a, c, `exports.x = x`의 x)은 사용처가 아니에요. require를 펼친 것(`...require('./a')`)과
   * `module.exports = require('./a')`는 다시 내보내기예요. 처리했으면 true.
   */
  private commonJsExport(n: SyntaxNode): boolean {
    if (n.type !== 'assignment_expression') return false;
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    if (!left || !right || left.type !== 'member_expression') return false;
    const target = left.text.replace(/\s/g, '');
    if (!/^(module\.exports|exports)(\.[\w$]+)?$/.test(target)) return false;
    const spec = requireSpec(right);
    if (spec !== null) {
      this.out.imports.push({ spec, range: rangeOf(namedChildren(right.childForFieldName('arguments')!)[0]!), reexport: true, emit: true });
      return true;
    }
    if (right.type === 'identifier') {
      this.bind(right);
      return true;
    }
    if (right.type === 'object') {
      for (const item of namedChildren(right)) {
        if (item.type === 'shorthand_property_identifier') this.bind(item);
        else if (item.type === 'pair' && item.childForFieldName('value')?.type === 'identifier') this.bind(item.childForFieldName('value')!);
        else if (item.type === 'spread_element' && requireSpec(namedChildren(item)[0]) !== null) {
          const call = namedChildren(item)[0]!;
          const arg = namedChildren(call.childForFieldName('arguments')!)[0]!;
          this.out.imports.push({ spec: stringValue(arg), range: rangeOf(arg), reexport: true, emit: true });
        } else this.refs(item, undefined, this.fileLocals);
      }
      return true;
    }
    this.refs(right, undefined, this.fileLocals);
    return true;
  }

  /** const/let/var 선언. require를 받는 것은 import예요(이름은 정의가 아니에요). */
  private variables(n: SyntaxNode, parent: number | undefined): void {
    const isConst = n.children.some((c) => c !== null && !c.isNamed && c.type === 'const');
    for (const d of namedChildren(n)) {
      if (d.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      const value = d.childForFieldName('value');
      if (!name) continue;
      const spec = requireSpec(value) ?? requireSpec(value?.type === 'member_expression' ? value.childForFieldName('object') : null);
      if (spec !== null) {
        this.out.imports.push({ spec, range: rangeOf(namedChildren(requireCall(value!).childForFieldName('arguments')!)[0]!), reexport: false, emit: true });
        if (name.type === 'identifier') this.declared.add(name.startIndex);
        else for (const id of patternNames(name)) this.bind(id);
        continue;
      }
      const kind: SymbolKind = isConst ? 'constant' : 'variable';
      const names = name.type === 'identifier' ? [name] : patternNames(name);
      const defs = names.map((id) => this.define(id, kind, d, parent));
      const self = defs.length === 1 ? defs[0] : parent;
      const locals = new Set<string>();
      if (value) {
        this.collectLocals(value, locals);
        this.refs(value, self, locals);
      }
      const type = d.childForFieldName('type');
      if (type) this.refs(type, self, locals);
    }
  }

  /** 함수(최상위) 또는 메서드. 지역 이름은 함수 전체(안쪽 함수 포함)를 한 범위로 봐요. */
  private callable(n: SyntaxNode, kind: SymbolKind, parent: number | undefined, nameNode?: SyntaxNode | null): void {
    // nameNode가 null이면 이름 없는 것(생성자 등)이에요. undefined면 name 칸을 봐요.
    const name = nameNode !== undefined ? nameNode : n.childForFieldName('name');
    const self = name && (name.type === 'identifier' || name.type === 'property_identifier') ? this.define(name, kind, n, parent) : parent;
    const locals = new Set<string>();
    this.collectLocals(n, locals);
    for (const c of namedChildren(n)) if (!same(c, name)) this.refs(c, self, locals);
  }

  /** 클래스. 상속(extends)과 구현(implements), JSDoc의 @implements·@extends도 봐요. */
  private klass(n: SyntaxNode, parent: number | undefined, prev: SyntaxNode | undefined): void {
    const name = n.childForFieldName('name');
    const self = name ? this.define(name, 'class', n, parent) : parent;
    const typeLocals = new Set<string>();
    for (const c of namedChildren(n)) if (c.type === 'type_parameters') this.collectLocals(c, typeLocals);
    const doc =prev?.type === 'comment' && prev.text.startsWith('/**') && prev.endPosition.row >= n.startPosition.row - 1 ? prev : undefined;
    const ownDoc = namedChildren(n).find((c) => c.type === 'comment' && c.text.startsWith('/**'));
    for (const comment of [doc, ownDoc]) if (comment) this.jsdocHeritage(comment, self);
    for (const c of namedChildren(n)) {
      if (same(c, name)) continue;
      if (c.type === 'class_heritage') this.heritage(c, self);
      else if (c.type === 'class_body') this.classBody(c, self);
      else this.refs(c, self, typeLocals);
    }
  }

  private heritage(h: SyntaxNode, self: number | undefined): void {
    for (const c of namedChildren(h)) {
      if (c.type === 'extends_clause') {
        for (const v of namedChildren(c)) this.superRef(v, 'extends', self);
      } else if (c.type === 'implements_clause') {
        for (const v of namedChildren(c)) this.superRef(v, 'implements', self);
      } else this.superRef(c, 'extends', self); // JavaScript: class_heritage 바로 아래가 식이에요.
    }
  }

  /** 상속·구현 절의 타입 하나. 이름(또는 a.B, B<T>)이면 그 종류로, 그 밖의 식(mixin 함수 호출 등)은 보통 사용처예요. */
  private superRef(v: SyntaxNode, kind: RelationKind, at: number | undefined): void {
    const head = v.type === 'generic_type' ? v.childForFieldName('name') ?? namedChildren(v)[0] : v;
    if (head && (head.type === 'identifier' || head.type === 'type_identifier')) {
      this.ref(head, kind, at);
      if (!same(head, v)) for (const c of namedChildren(v)) if (!same(c, head)) this.refs(c, at, new Set());
      return;
    }
    if (head && (head.type === 'member_expression' || head.type === 'nested_type_identifier')) {
      const last = namedChildren(head).at(-1)!;
      const first = namedChildren(head)[0]!;
      this.ref(last, kind, at, first.type === 'identifier' ? { qualifier: first.text } : {});
      return;
    }
    if (v.type === 'type_arguments') return this.refs(v, at, new Set());
    this.refs(v, at, new Set());
  }

  /** JSDoc의 `@implements {X}`, `@extends {X}`(`@augments`). JavaScript에서 인터페이스 구현을 적는 방법이에요. */
  private jsdocHeritage(comment: SyntaxNode, at: number | undefined): void {
    const text = comment.text;
    for (const m of text.matchAll(/@(implements|extends|augments)\s+\{?\s*([A-Za-z_$][\w$]*)/g)) {
      const offset = m.index + m[0].length - m[2]!.length;
      const before = text.slice(0, offset);
      const lines = before.split('\n');
      const startLine = comment.startPosition.row + lines.length - 1;
      const startColumn = lines.length === 1 ? comment.startPosition.column + offset : lines.at(-1)!.length;
      this.out.references.push({
        name: m[2]!,
        range: { startLine, startColumn, endLine: startLine, endColumn: startColumn + m[2]!.length },
        kind: m[1] === 'implements' ? 'implements' : 'extends',
        ...(at !== undefined ? { in: at } : {}),
      });
    }
  }

  private classBody(body: SyntaxNode, self: number | undefined): void {
    for (const m of namedChildren(body)) {
      switch (m.type) {
        case 'method_definition': {
          const name = m.childForFieldName('name');
          if (name?.type === 'property_identifier' && name.text === 'constructor') {
            // 생성자는 정의를 따로 만들지 않고 클래스에 속해요(정밀 어댑터가 클래스로 합치는 것과 같아요).
            this.constructorParams(m, self);
            this.callable(m, 'constructor', self, null);
            break;
          }
          const accessor = m.children.find((c) => c !== null && !c.isNamed && (c.type === 'get' || c.type === 'set'))?.type;
          this.callable(m, accessor === 'get' ? 'getter' : accessor === 'set' ? 'setter' : 'method', self, name?.type === 'property_identifier' ? name : null);
          break;
        }
        case 'method_signature':
        case 'abstract_method_signature': {
          const name = m.childForFieldName('name');
          this.callable(m, 'method', self, name?.type === 'property_identifier' ? name : null);
          break;
        }
        case 'public_field_definition':
        case 'field_definition': {
          const name = m.childForFieldName('name') ?? m.childForFieldName('property');
          const field = name?.type === 'property_identifier' ? this.define(name, 'field', m, self) : self;
          const locals = new Set<string>();
          this.collectLocals(m, locals);
          for (const c of namedChildren(m)) if (!same(c, name)) this.refs(c, field, locals);
          break;
        }
        case 'comment':
          break;
        default:
          this.refs(m, self, new Set());
      }
    }
  }

  /** TypeScript 매개변수 속성(`constructor(private readonly x: X)`)은 필드예요. */
  private constructorParams(ctor: SyntaxNode, self: number | undefined): void {
    for (const p of namedChildren(ctor.childForFieldName('parameters') ?? ctor)) {
      if (!namedChildren(p).some((c) => c.type === 'accessibility_modifier' || c.type === 'readonly' || c.type === 'override_modifier')) continue;
      const id = p.childForFieldName('pattern');
      if (id?.type === 'identifier') this.define(id, 'field', p, self);
    }
  }

  private interface(n: SyntaxNode, parent: number | undefined): void {
    const name = n.childForFieldName('name');
    if (!name) return;
    const self = this.define(name, 'interface', n, parent);
    for (const c of namedChildren(n)) {
      if (same(c, name)) continue;
      if (c.type === 'extends_type_clause') for (const v of namedChildren(c)) this.superRef(v, 'extends', self);
      else if (c.type === 'interface_body' || c.type === 'object_type') {
        for (const m of namedChildren(c)) {
          const id = m.childForFieldName('name');
          if (m.type === 'method_signature' && id?.type === 'property_identifier') this.callable(m, 'method', self, id);
          else if (m.type === 'property_signature' && id?.type === 'property_identifier') {
            const field = this.define(id, 'field', m, self);
            for (const x of namedChildren(m)) if (!same(x, id)) this.refs(x, field, new Set());
          } else this.refs(m, self, new Set());
        }
      } else this.refs(c, self, new Set());
    }
  }

  /** 노드 안에서 선언되는 지역 이름(매개변수, 지역 변수·함수·클래스, 반복 변수, catch 변수, 타입 매개변수). */
  private collectLocals(n: SyntaxNode, into: Set<string>): void {
    const add = (id: SyntaxNode | null | undefined) => {
      if (!id) return;
      if (id.type === 'identifier' || id.type === 'type_identifier' || id.type === 'shorthand_property_identifier_pattern') {
        into.add(id.text);
        this.declared.add(id.startIndex);
      } else for (const x of patternNames(id)) add(x);
    };
    const visit = (x: SyntaxNode) => {
      switch (x.type) {
        case 'formal_parameters':
          for (const p of namedChildren(x)) {
            if (p.type === 'identifier' || p.type.endsWith('_pattern')) add(p);
            else if (p.type === 'required_parameter' || p.type === 'optional_parameter') {
              // 매개변수 속성(private x)은 필드로 정의했어요(constructorParams). 그래도 본문 안에서는 지역 이름이에요.
              add(p.childForFieldName('pattern'));
            }
          }
          break;
        case 'arrow_function': {
          const p = x.childForFieldName('parameter');
          if (p) add(p);
          break;
        }
        case 'variable_declarator':
          add(x.childForFieldName('name'));
          break;
        case 'for_in_statement':
          add(x.childForFieldName('left'));
          break;
        case 'catch_clause':
          add(x.childForFieldName('parameter'));
          break;
        case 'type_parameter':
          add(x.childForFieldName('name'));
          break;
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'class_declaration':
          add(x.childForFieldName('name'));
          break;
      }
      for (const c of namedChildren(x)) visit(c);
    };
    visit(n);
  }

  /** 노드 안의 사용처를 모두 모아요. at은 감싸는 정의, locals는 지역 이름. */
  private refs(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    if (LEAVES.has(n.type)) return;
    switch (n.type) {
      case 'identifier':
        return this.name(n, at, locals);
      case 'type_identifier':
        if (!this.declared.has(n.startIndex) && !locals.has(n.text)) this.ref(n, 'reference', at);
        return;
      case 'shorthand_property_identifier':
        // 객체 글 `{ a }`의 a는 그 이름을 읽어요.
        if (!this.declared.has(n.startIndex) && !locals.has(n.text)) this.ref(n, 'read', at);
        return;
      case 'member_expression':
        return this.member(n, at, locals);
      case 'nested_type_identifier': {
        const parts = namedChildren(n);
        const first = parts[0]!;
        const last = parts.at(-1)!;
        if (first.type === 'identifier' && this.externalAliases.has(first.text)) return;
        if (first.type === 'identifier' && this.moduleAliases.has(first.text)) return this.ref(last, 'reference', at);
        this.ref(last, 'reference', at, first.type === 'identifier' ? { qualifier: first.text } : {});
        return;
      }
      case 'call_expression': {
        const spec = requireSpec(n);
        if (spec !== null) {
          const arg = namedChildren(n.childForFieldName('arguments')!)[0]!;
          this.out.imports.push({ spec, range: rangeOf(arg), reexport: false, emit: true });
          return;
        }
        break;
      }
      case 'class':
      case 'class_declaration':
        // 함수 안의 클래스: 정의는 만들지 않고 안의 사용처만 봐요.
        for (const c of namedChildren(n)) {
          if (c.type === 'class_heritage') this.heritage(c, at);
          else this.refs(c, at, locals);
        }
        return;
      case 'property_identifier':
      case 'private_property_identifier':
        return; // 객체 글의 열쇠, 클래스 멤버 이름 등(멤버 접근은 member에서 봐요).
    }
    for (const c of namedChildren(n)) this.refs(c, at, locals);
  }

  /** 이름 하나(수신자 없는). */
  private name(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    if (this.declared.has(n.startIndex) || locals.has(n.text)) return;
    if (n.text === 'undefined' || n.text === 'require' || n.text === 'module' || n.text === 'exports') return;
    this.ref(n, usageKind(n), at);
  }

  /** 수신자.이름 */
  private member(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    const object = n.childForFieldName('object');
    const property = n.childForFieldName('property');
    if (object) this.refs(object, at, locals);
    if (!object || !property || property.type !== 'property_identifier') return;
    const kind = usageKind(n);
    if (object.type === 'this') return this.ref(property, kind, at);
    if (object.type === 'identifier') {
      if (this.externalAliases.has(object.text)) return;
      if (this.moduleAliases.has(object.text) && !locals.has(object.text)) return this.ref(property, kind, at);
      return this.ref(property, kind, at, { qualifier: object.text });
    }
    this.ref(property, kind, at, {});
  }

  private ref(n: SyntaxNode, kind: RelationKind, at: number | undefined, member?: { qualifier?: string }): void {
    this.out.references.push({ name: n.text, range: rangeOf(n), kind, ...(at !== undefined ? { in: at } : {}), ...(member ? { member } : {}) });
  }
}

/** 식 노드가 쓰이는 자리의 종류: 부르면 call, 대입의 왼쪽이나 ++/--면 write, 그 밖은 read. */
function usageKind(n: SyntaxNode): RelationKind {
  const p = n.parent;
  if (!p) return 'read';
  if (p.type === 'call_expression' && same(p.childForFieldName('function'), n)) return 'call';
  if (p.type === 'new_expression' && same(p.childForFieldName('constructor'), n)) return 'call';
  if ((p.type === 'assignment_expression' || p.type === 'augmented_assignment_expression') && same(p.childForFieldName('left'), n)) return 'write';
  if (p.type === 'update_expression') return 'write';
  if (p.type === 'non_null_expression' || p.type === 'parenthesized_expression') return usageKind(p);
  return 'read';
}

/** require(…) 호출 노드(`require('x').y`면 그 안의 호출). */
function requireCall(value: SyntaxNode): SyntaxNode {
  return value.type === 'member_expression' ? value.childForFieldName('object')! : value;
}

/** 구조 분해 꼴(`{ a, b: c }`, `[a, ...b]`, `a = 1`) 안의 이름들. */
function patternNames(p: SyntaxNode): SyntaxNode[] {
  if (p.type === 'identifier' || p.type === 'shorthand_property_identifier_pattern') return [p];
  if (p.type === 'pair_pattern') {
    const v = p.childForFieldName('value');
    return v ? patternNames(v) : [];
  }
  if (p.type === 'assignment_pattern' || p.type === 'object_assignment_pattern') {
    const l = p.childForFieldName('left') ?? namedChildren(p)[0];
    return l ? patternNames(l) : [];
  }
  if (p.type === 'object_pattern' || p.type === 'array_pattern' || p.type === 'rest_pattern') return namedChildren(p).flatMap(patternNames);
  return [];
}

/** 파일 하나의 구문을 뽑아요. 정밀 어댑터도 사용처의 종류를 가릴 때 써요. */
export function extractJsTs(root: SyntaxNode): JsTsSyntax {
  const x = new Extractor();
  x.program(root);
  return x.out;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** 경로(꼬리 없을 수 있음)를 저장소의 JS/TS 파일로: 그대로, 꼬리 붙이기, .js → .ts 바꾸기, 폴더의 index. */
function resolveFile(base: string, files: ReadonlySet<string>): string | null {
  if (files.has(base) && isJsTsFile(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) if (files.has(base + ext)) return base + ext;
  const swapped = /\.(m|c)?jsx?$/.exec(base);
  if (swapped) {
    const stem = base.slice(0, swapped.index);
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(stem + ext)) return stem + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

/** 저장소 안 패키지(package.json의 name → 폴더). 작업 공간(workspace) 패키지를 이름으로 가져올 때 써요. */
const packagesOf = perRepo((repo): { roots: Set<string>; byName: Map<string, string> } => {
  const roots = packageRootsOf(repo.files);
  const byName = new Map<string, string>();
  for (const dir of roots) {
    try {
      const name = JSON.parse(repo.read(dir ? `${dir}/package.json` : 'package.json') ?? '{}').name;
      if (typeof name === 'string') byName.set(name, dir);
    } catch {
      // 읽지 못한 package.json은 건너뛰어요.
    }
  }
  return { roots, byName };
});

export const typescriptInferred: InferredLanguage = {
  language: 'typescript',
  grammar: 'typescript',
  grammarFor: jsTsGrammar,
  fileLanguage: jsTsLanguage,
  owns: isJsTsFile,
  excluded: (path, text, repo) => isGeneratedJsTs(path, text, packagesOf(repo).roots),
  role: (path) => jsTsRole(path),
  extract: (root) => extractJsTs(root),
  resolveImport(fromPath, spec, repo) {
    if (isRelative(spec)) {
      const joined = posix.normalize(posix.join(posix.dirname(fromPath), spec));
      return joined.startsWith('../') ? null : resolveFile(joined, repo.files);
    }
    // 저장소 안 패키지를 이름으로 가져오는 것(작업 공간): 그 package.json 폴더 안에서 찾아요.
    const m = /^(@[^/]+\/[^/]+|[^@/][^/]*)(?:\/(.+))?$/.exec(spec);
    const dir = m ? packagesOf(repo).byName.get(m[1]!) : undefined;
    if (dir === undefined) return null;
    const base = (sub: string) => (dir ? `${dir}/${sub}` : sub);
    if (m![2]) return resolveFile(base(m![2]), repo.files);
    return resolveFile(base('src/index'), repo.files) ?? resolveFile(base('index'), repo.files);
  },
};
