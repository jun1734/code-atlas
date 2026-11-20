// Python 추정 규칙: tree-sitter-python 구문 나무에서 정의, 사용처, import를 뽑아요.
// 이름 잇기는 추정 층(layer.ts)이 해요. 파일 고르기(생성된 코드, 테스트)와 모듈 풀기는 정밀 어댑터와 같은 Python 관례를 써요.
// 정밀 어댑터(src/adapters/python-refine.ts)도 이 구문 읽기(pythonSyntax)로 정의의 종류와 사용처의 종류를 가려요.
import { isExcludedPython, ownsPython, pythonProjects, pythonRole, resolvePythonModule } from '../adapters/python-conventions.ts';
import type { Range, RelationKind, SymbolKind } from '../facts.ts';
import type { FileSyntax, InferredLanguage, RepoView } from './layer.ts';
import { namedChildren, same, type SyntaxNode } from './tree-sitter.ts';

const rangeOf = (n: SyntaxNode): Range => ({
  startLine: n.startPosition.row,
  startColumn: n.startPosition.column,
  endLine: n.endPosition.row,
  endColumn: n.endPosition.column,
});

/** 자리 열쇠: 이름이 시작하는 줄과 열(0부터). */
export const positionKey = (line: number, column: number) => `${line}:${column}`;

/** 한 파일의 구문 읽기 결과. file은 추정 층이 쓰고, kindAt은 정밀 어댑터가 사용처의 종류를 가릴 때 써요. */
export interface PythonSyntax {
  file: FileSyntax;
  /** 이름(식별자)이 놓인 자리마다 문법으로 가린 관계 종류. 지역 이름과 `.` 뒤 이름도 들어요. */
  kindAt: Map<string, RelationKind>;
  /** `from 모듈 import 이름`으로 가져온 이름들(모듈은 적힌 그대로, 이름은 별칭 전의 원래 이름). */
  importedNames: { module: string; name: string; range: Range }[];
}

/** 블록이 든 문(모듈·클래스 본문에서 그 안의 정의도 같은 층의 정의예요). */
const COMPOUND = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'for_statement',
  'while_statement',
  'match_statement',
  'case_clause',
  'block',
]);
const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'parenthesized_expression']);
/** 값으로 쓰는 모양이 대문자와 밑줄뿐이면 상수로 봐요(PEP 8의 상수 이름 관례). */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/** 이름이 놓인 곳(대입의 왼쪽인 `a`, `a.b`, `a[0]`)을 바깥으로 올라가며 대입 대상인지 봐요. */
function isWriteTarget(expr: SyntaxNode): boolean {
  let x = expr;
  while (x.parent && PATTERNS.has(x.parent.type)) x = x.parent;
  const p = x.parent;
  if (!p) return false;
  if (p.type === 'assignment' || p.type === 'augmented_assignment') return same(p.childForFieldName('left'), x);
  if (p.type === 'for_statement' || p.type === 'for_in_clause') return same(p.childForFieldName('left'), x);
  if (p.type === 'delete_statement') return true;
  if (p.type === 'named_expression') return same(p.childForFieldName('name'), x);
  return false;
}

/** 모양에서 대입되는 이름(식별자)들. */
function targetNames(n: SyntaxNode | null): SyntaxNode[] {
  if (!n) return [];
  if (n.type === 'identifier') return [n];
  if (PATTERNS.has(n.type) || n.type === 'list_splat_pattern') return namedChildren(n).flatMap(targetNames);
  return [];
}

/** 노드가 타입 표기(`x: T`, `-> T`) 안에 있는지. */
function inAnnotation(n: SyntaxNode): boolean {
  for (let x = n.parent; x; x = x.parent) {
    if (x.type === 'type') return true;
    if (x.type === 'block' || x.type === 'module' || x.type === 'expression_statement') return false;
  }
  return false;
}

/** 클래스 머리의 바탕 타입 자리(`class A(B, mod.C, Generic[T])`의 B, C, Generic)인지. */
function isBaseClass(expr: SyntaxNode): boolean {
  let x = expr;
  if (x.parent?.type === 'subscript' && same(x.parent.childForFieldName('value'), x)) x = x.parent;
  const list = x.parent;
  return list?.type === 'argument_list' && list.parent?.type === 'class_definition' && same(list.parent.childForFieldName('superclasses'), list);
}

/** 이름 하나가 쓰인 곳의 관계 종류(문법만으로 가려요). */
function usageKind(n: SyntaxNode): RelationKind {
  const p = n.parent;
  const expr = p?.type === 'attribute' && same(p.childForFieldName('attribute'), n) ? p : n;
  const q = expr.parent;
  if (q?.type === 'call' && same(q.childForFieldName('function'), expr)) return 'call';
  if (q?.type === 'decorator') return 'call';
  if (isWriteTarget(expr)) return 'write';
  if (isBaseClass(expr)) return 'extends';
  if (q?.type === 'global_statement' || q?.type === 'nonlocal_statement') return 'reference';
  for (let x: SyntaxNode | null = q; x; x = x.parent) {
    if (x.type === 'import_from_statement' || x.type === 'import_statement') return 'reference';
    if (x.type === 'block' || x.type === 'module') break;
  }
  if (inAnnotation(n)) return 'reference';
  return 'read';
}

/** 클래스가 Protocol을 바탕으로 하면 인터페이스예요(`Protocol`, `typing.Protocol`, `Protocol[T]`). */
function isProtocol(cls: SyntaxNode): boolean {
  const bases = cls.childForFieldName('superclasses');
  if (!bases) return false;
  return namedChildren(bases).some((b) => {
    const v = b.type === 'subscript' ? b.childForFieldName('value') : b;
    return !!v && (v.text === 'Protocol' || v.text.endsWith('.Protocol'));
  });
}

/** 타입 표기가 Final(`Final`, `Final[int]`, `typing.Final`)인지. */
function isFinal(type: SyntaxNode | null): boolean {
  return !!type && /^(typing\.)?Final\b/.test(type.text);
}

/** 함수의 종류: 모듈 수준은 function, 클래스 안은 method(`__init__`는 constructor, @property는 getter, @x.setter는 setter). */
function callableKind(fn: SyntaxNode, decorators: SyntaxNode[], inClass: boolean): SymbolKind {
  if (!inClass) return 'function';
  if (fn.childForFieldName('name')?.text === '__init__') return 'constructor';
  for (const d of decorators) {
    const t = d.text.replace(/^@\s*/, '');
    if (/^(functools\.)?(property|cached_property)$/.test(t)) return 'getter';
    if (/\.setter$/.test(t)) return 'setter';
  }
  return 'method';
}

interface Scope {
  /** 감싸는 정의(같은 파일 definitions의 번호). 사용처의 in이에요. */
  at: number | undefined;
  /** 지역 이름(매개변수, 지역 변수 등). 이 이름의 사용처는 넣지 않아요. */
  locals: Set<string>;
  /** 이 층이 모듈(module), 클래스 본문(class), 함수 본문(function) 중 어디인지. */
  level: 'module' | 'class' | 'function';
  /** 메서드 안이면 그 클래스(self.x 필드를 거기 정의해요). */
  cls?: number;
}

/** 한 파일을 읽는 동안의 상태. */
class Extractor {
  readonly out: FileSyntax = { definitions: [], references: [], imports: [] };
  readonly kindAt = new Map<string, RelationKind>();
  readonly importedNames: PythonSyntax['importedNames'] = [];
  /** 정의의 이름 노드(사용처로 세지 않아요). 시작 위치로 가려요. */
  private readonly declared = new Set<number>();
  /** `import X`, `import X as Y`가 묶은 이름(모듈). `X.f`의 f는 그 모듈의 최상위 이름이에요. */
  private readonly modules = new Set<string>();
  /** `from P import n`이 묶은 이름. 소문자로 시작하면 모듈일 수 있어요(아래 member). */
  private readonly fromImported = new Set<string>();
  /** 정의를 이미 만든 이름: 층(모듈 또는 클래스 번호)마다. 같은 이름에 다시 대입하면 쓰기예요. */
  private readonly defined = new Map<string, Set<string>>();

  private define(name: SyntaxNode, kind: SymbolKind, enclosing: Range, parent: number | undefined): number {
    this.declared.add(name.startIndex);
    this.out.definitions.push({ name: name.text, kind, range: rangeOf(name), enclosingRange: enclosing, ...(parent !== undefined ? { parent } : {}) });
    return this.out.definitions.length - 1;
  }

  /** 이 층(모듈이나 클래스)에 이 이름을 처음 정의하는지. 처음이면 표시해 둬요. */
  private firstIn(layer: number | undefined, name: string): boolean {
    const k = String(layer ?? 'module');
    const set = this.defined.get(k) ?? new Set<string>();
    this.defined.set(k, set);
    if (set.has(name)) return false;
    set.add(name);
    return true;
  }

  /** 문이 늘어선 곳(모듈, 클래스 본문, 함수 본문). */
  statements(container: SyntaxNode, scope: Scope): void {
    for (const s of namedChildren(container)) this.statement(s, scope);
  }

  private statement(s: SyntaxNode, scope: Scope): void {
    switch (s.type) {
      case 'import_statement':
      case 'import_from_statement':
        return this.importStatement(s, scope);
      case 'future_import_statement':
      case 'comment':
        return;
      case 'class_definition':
        return this.classDef(s, [], s, scope);
      case 'function_definition':
        return this.functionDef(s, [], s, scope);
      case 'decorated_definition': {
        const def = s.childForFieldName('definition');
        const decorators = namedChildren(s).filter((c) => c.type === 'decorator');
        if (def?.type === 'class_definition') return this.classDef(def, decorators, s, scope);
        if (def?.type === 'function_definition') return this.functionDef(def, decorators, s, scope);
        return this.refs(s, scope.at, scope.locals);
      }
      case 'expression_statement': {
        const inner = namedChildren(s)[0];
        if (inner?.type === 'assignment' && scope.level !== 'function') return this.assignment(inner, s, scope);
        if (inner?.type === 'assignment' && scope.cls !== undefined) return this.selfAssignment(inner, scope);
        return this.refs(s, scope.at, scope.locals);
      }
      default:
        if (COMPOUND.has(s.type)) {
          // if/try/with 안의 문도 그 층의 문이에요(예: 모듈 수준 try: import … except: …, if TYPE_CHECKING:, 메서드 안 if 속 self.x = …).
          for (const c of namedChildren(s)) {
            if (c.type === 'block' || COMPOUND.has(c.type)) this.statements(c, scope);
            else this.refs(c, scope.at, scope.locals);
          }
          return;
        }
        return this.refs(s, scope.at, scope.locals);
    }
  }

  /** 모듈·클래스 수준의 대입: 처음 대입하는 이름은 정의(변수, 상수, 필드)이고 다시 대입하면 쓰기예요. */
  private assignment(a: SyntaxNode, stmt: SyntaxNode, scope: Scope): void {
    const left = a.childForFieldName('left');
    const type = a.childForFieldName('type');
    const names = targetNames(left).filter((n) => this.firstIn(scope.at, n.text));
    let self = scope.at;
    for (const n of names) {
      const constant = isFinal(type) || CONSTANT_NAME.test(n.text);
      const kind: SymbolKind = constant ? 'constant' : scope.level === 'class' ? 'field' : 'variable';
      const i = this.define(n, kind, rangeOf(stmt), scope.at);
      if (self === scope.at) self = i;
    }
    for (const c of namedChildren(a)) this.refs(c, self, scope.locals);
  }

  /** 메서드 안의 `self.x = …`: 클래스에 x가 아직 없으면 그 자리를 필드 x의 정의로 봐요(정밀 색인기와 같아요). */
  private selfAssignment(a: SyntaxNode, scope: Scope): void {
    const left = a.childForFieldName('left');
    const obj = left?.type === 'attribute' ? left.childForFieldName('object') : null;
    const attr = left?.type === 'attribute' ? left.childForFieldName('attribute') : null;
    if (obj?.type === 'identifier' && obj.text === 'self' && attr && this.firstIn(scope.cls, attr.text)) {
      const enclosing = a.parent ?? a;
      this.define(attr, 'field', rangeOf(enclosing), scope.cls);
      this.kindAt.set(positionKey(attr.startPosition.row, attr.startPosition.column), 'write');
    }
    this.refs(a, scope.at, scope.locals);
  }

  private classDef(c: SyntaxNode, decorators: SyntaxNode[], whole: SyntaxNode, scope: Scope): void {
    const name = c.childForFieldName('name');
    if (!name) return;
    if (scope.level === 'function') {
      // 함수 안의 클래스는 지역 이름이에요.
      scope.locals.add(name.text);
      this.declared.add(name.startIndex);
      for (const d of decorators) this.refs(d, scope.at, scope.locals);
      for (const x of namedChildren(c)) if (!same(x, name)) this.refs(x, scope.at, scope.locals);
      return;
    }
    this.firstIn(scope.at, name.text);
    const self = this.define(name, isProtocol(c) ? 'interface' : 'class', rangeOf(whole), scope.at);
    for (const d of decorators) this.refs(d, self, scope.locals);
    const bases = c.childForFieldName('superclasses');
    if (bases) this.refs(bases, self, scope.locals);
    const body = c.childForFieldName('body');
    if (body) this.statements(body, { at: self, locals: new Set(), level: 'class' });
  }

  private functionDef(f: SyntaxNode, decorators: SyntaxNode[], whole: SyntaxNode, scope: Scope): void {
    const name = f.childForFieldName('name');
    if (!name) return;
    let self = scope.at;
    if (scope.level === 'function') {
      // 함수 안의 함수는 지역 이름이에요. 그 안의 사용처는 바깥 함수에 속해요.
      scope.locals.add(name.text);
      this.declared.add(name.startIndex);
    } else {
      this.firstIn(scope.at, name.text);
      self = this.define(name, callableKind(f, decorators, scope.level === 'class'), rangeOf(whole), scope.at);
    }
    for (const d of decorators) this.refs(d, self, scope.locals);
    const locals = new Set(scope.locals);
    const params = f.childForFieldName('parameters');
    if (params) this.parameters(params, locals);
    const body = f.childForFieldName('body');
    if (body) this.collectLocals(body, locals);
    for (const x of namedChildren(f)) {
      if (same(x, name) || same(x, body)) continue;
      // 매개변수의 기본값과 타입 표기는 바깥 이름을 봐요.
      this.refs(x, self, scope.locals);
    }
    const cls = scope.level === 'class' ? scope.at : scope.cls;
    if (body) this.statements(body, { at: self, locals, level: 'function', ...(cls !== undefined ? { cls } : {}) });
  }

  /** 매개변수 이름을 지역 이름으로(그 노드는 사용처로 세지 않아요). */
  private parameters(params: SyntaxNode, into: Set<string>): void {
    for (const p of namedChildren(params)) {
      const id =
        p.type === 'identifier'
          ? p
          : p.type === 'default_parameter' || p.type === 'typed_default_parameter'
            ? p.childForFieldName('name')
            : namedChildren(p).find((c) => c.type === 'identifier');
      if (id?.type === 'identifier') {
        into.add(id.text);
        this.declared.add(id.startIndex);
        this.kindAt.set(positionKey(id.startPosition.row, id.startPosition.column), 'write');
      }
    }
  }

  /**
   * 함수 본문에서 지역 이름(대입, for, with … as, except … as, :=, 함수 안의 def·class)을 모아요.
   * global·nonlocal로 밝힌 이름은 지역이 아니에요. 안쪽 함수·lambda·클래스 본문은 들여다보지 않아요.
   */
  private collectLocals(body: SyntaxNode, into: Set<string>): void {
    const outer = new Set<string>();
    const visit = (x: SyntaxNode) => {
      switch (x.type) {
        case 'assignment':
        case 'augmented_assignment':
        case 'for_statement':
          for (const n of targetNames(x.childForFieldName('left'))) into.add(n.text);
          break;
        case 'named_expression': {
          const n = x.childForFieldName('name');
          if (n) into.add(n.text);
          break;
        }
        case 'as_pattern_target':
          for (const n of namedChildren(x).flatMap((c) => (c.type === 'identifier' ? [c] : targetNames(c)))) into.add(n.text);
          break;
        case 'except_clause': {
          // `except E as e`: 문법 판에 따라 as_pattern 또는 이름 칸으로 나와요.
          const alias = x.childForFieldName('alias');
          if (alias?.type === 'identifier') into.add(alias.text);
          break;
        }
        case 'global_statement':
        case 'nonlocal_statement':
          for (const n of namedChildren(x)) if (n.type === 'identifier') outer.add(n.text);
          break;
        case 'function_definition':
        case 'class_definition': {
          const n = x.childForFieldName('name');
          if (n) into.add(n.text);
          return;
        }
        case 'lambda':
          return;
      }
      for (const c of namedChildren(x)) visit(c);
    };
    visit(body);
    for (const n of outer) into.delete(n);
  }

  /** import 문: 파일→파일 관계와, from … import의 이름 사용처. */
  private importStatement(s: SyntaxNode, scope: Scope): void {
    if (s.type === 'import_statement') {
      for (const item of namedChildren(s)) {
        const dotted = item.type === 'aliased_import' ? item.childForFieldName('name') : item;
        if (!dotted || dotted.type !== 'dotted_name') continue;
        this.out.imports.push({ spec: dotted.text, range: rangeOf(dotted), reexport: false, emit: true });
        const alias = item.type === 'aliased_import' ? item.childForFieldName('alias') : null;
        this.modules.add(alias?.text ?? dotted.text.split('.')[0]!);
        for (const id of dotted.descendantsOfType('identifier')) if (id) this.kindAt.set(positionKey(id.startPosition.row, id.startPosition.column), 'reference');
      }
      return;
    }
    const moduleName = s.childForFieldName('module_name');
    if (!moduleName) return;
    const spec = moduleName.text.replace(/\s+/g, '');
    const onlyDots = /^\.+$/.test(spec);
    // Python에서 가져온 이름은 그 모듈의 이름이 돼요(다시 내보냄). 그래서 from … import는 reexport예요.
    if (!onlyDots) this.out.imports.push({ spec, range: rangeOf(moduleName), reexport: true, emit: true });
    if (namedChildren(s).some((c) => c.type === 'wildcard_import')) return;
    for (const item of namedChildren(s)) {
      if (same(item, moduleName)) continue;
      const dotted = item.type === 'aliased_import' ? item.childForFieldName('name') : item;
      if (!dotted || dotted.type !== 'dotted_name') continue;
      // `from P import n`의 n은 하위 모듈일 수도 있어요(P.n). 파일로 풀리면 import 관계가 돼요.
      const sub = onlyDots ? `${spec}${dotted.text}` : `${spec}.${dotted.text}`;
      this.out.imports.push({ spec: sub, range: rangeOf(dotted), reexport: true, emit: true });
      const alias = item.type === 'aliased_import' ? item.childForFieldName('alias') : null;
      this.fromImported.add(alias?.text ?? dotted.text);
      this.importedNames.push({ module: spec, name: dotted.text, range: rangeOf(dotted) });
      this.refs(dotted, scope.at, new Set());
    }
  }

  /** 노드 안의 사용처를 모두 모아요. at은 감싸는 정의, locals는 지역 이름. */
  refs(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    switch (n.type) {
      case 'identifier':
        return this.name(n, at, locals);
      case 'comment':
        return;
      case 'string':
        // f-string의 {…} 안만 식이에요.
        for (const c of namedChildren(n)) if (c.type === 'interpolation') this.refs(c, at, locals);
        return;
      case 'keyword_argument': {
        // f(name=value)의 name은 매개변수 이름이라 사용처가 아니에요.
        const value = n.childForFieldName('value');
        if (value) this.refs(value, at, locals);
        return;
      }
      case 'attribute': {
        const obj = n.childForFieldName('object');
        const attr = n.childForFieldName('attribute');
        if (obj) this.refs(obj, at, locals);
        if (attr) this.member(attr, obj, at, locals);
        return;
      }
      case 'lambda': {
        const inner = new Set(locals);
        const params = n.childForFieldName('parameters');
        if (params) this.parameters(params, inner);
        const body = n.childForFieldName('body');
        if (body) this.refs(body, at, inner);
        return;
      }
      case 'import_statement':
      case 'import_from_statement':
        return this.importStatement(n, { at, locals, level: 'function' });
      case 'class_definition':
      case 'function_definition':
      case 'decorated_definition':
        return this.statement(n, { at, locals, level: 'function' });
    }
    if (COMPREHENSIONS.has(n.type)) {
      const inner = new Set(locals);
      for (const clause of n.descendantsOfType('for_in_clause')) for (const t of targetNames(clause?.childForFieldName('left') ?? null)) inner.add(t.text);
      for (const c of namedChildren(n)) this.refs(c, at, inner);
      return;
    }
    for (const c of namedChildren(n)) this.refs(c, at, locals);
  }

  private name(n: SyntaxNode, at: number | undefined, locals: Set<string>): void {
    const kind = usageKind(n);
    this.kindAt.set(positionKey(n.startPosition.row, n.startPosition.column), kind);
    if (this.declared.has(n.startIndex) || locals.has(n.text)) return;
    this.ref(n, kind, at);
  }

  /** `수신자.이름`의 이름. */
  private member(attr: SyntaxNode, obj: SyntaxNode | null, at: number | undefined, locals: Set<string>): void {
    if (this.declared.has(attr.startIndex)) return;
    const kind = usageKind(attr);
    this.kindAt.set(positionKey(attr.startPosition.row, attr.startPosition.column), kind);
    const receiver = obj?.type === 'identifier' ? obj.text : undefined;
    // self.x, cls.x: 감싸는 타입의 멤버부터 찾는 이름이에요.
    if (receiver === 'self' || receiver === 'cls') return this.ref(attr, kind, at);
    // 모듈.x: 그 모듈의 최상위 이름이에요. `from P import m`의 m은 소문자로 시작하면 모듈로 봐요(PEP 8: 모듈 이름은 소문자).
    if (receiver !== undefined && !locals.has(receiver) && (this.modules.has(receiver) || (this.fromImported.has(receiver) && /^[a-z_]/.test(receiver)))) {
      return this.ref(attr, kind, at);
    }
    this.ref(attr, kind, at, receiver !== undefined ? { qualifier: receiver } : {});
  }

  private ref(n: SyntaxNode, kind: RelationKind, at: number | undefined, member?: { qualifier?: string }): void {
    this.out.references.push({ name: n.text, range: rangeOf(n), kind, ...(at !== undefined ? { in: at } : {}), ...(member ? { member } : {}) });
  }
}

/** Python 파일 하나의 구문을 읽어요. */
export function pythonSyntax(root: SyntaxNode): PythonSyntax {
  const x = new Extractor();
  x.statements(root, { at: undefined, locals: new Set(), level: 'module' });
  return { file: x.out, kindAt: x.kindAt, importedNames: x.importedNames };
}

const projectCache = new WeakMap<RepoView, string[]>();
const projectsOf = (repo: RepoView) => {
  let p = projectCache.get(repo);
  if (!p) projectCache.set(repo, (p = pythonProjects(repo.files)));
  return p;
};

export const pythonInferred: InferredLanguage = {
  language: 'python',
  grammar: 'python',
  owns: ownsPython,
  excluded: (path, text) => isExcludedPython(path, text),
  role: (path) => pythonRole(path),
  extract: (root) => pythonSyntax(root).file,
  resolveImport: (fromPath, spec, repo) => resolvePythonModule(fromPath, spec, repo.files, projectsOf(repo)),
};
