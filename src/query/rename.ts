// rename: 이름 하나를 새 이름으로 바꿀 때 고칠 자리 전부를 계획으로 돌려줘요. 파일은 고치지 않아요(고치는 것은 부르는 쪽).
// 이름은 context와 같은 해석기(resolvePoint)로 찾고, 여럿에 맞으면 고르지 않고 후보를 돌려줘요.
// 고칠 자리는 색인의 정의와 사용처예요. 정밀 층에서 온 것은 edits, 추정 층에서 온 것과 구문으로만 찾은 것은 inferred에 따로 나와요.
// 언어를 아는 것은 없어요. 구문 확인에 쓰는 문법만 언어 목록(LANGUAGES)의 추정 규칙에서 빌려요.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareText, cut, DEFAULT_LIMIT, type Page } from '../answer.ts';
import type { Confidence, FileRole, RelationKind } from '../facts.ts';
import type { GraphStore, SymbolRow } from '../graph/store.ts';
import { inferredSource } from '../inferred/layer.ts';
import { parserFor, type SyntaxNode } from '../inferred/tree-sitter.ts';
import { LANGUAGES } from '../languages.ts';
import { UserError } from '../locate.ts';
import type { QueryDef } from '../queries.ts';
import { resolvePoint } from './point.ts';

/**
 * 고칠 자리 하나. 한 줄 안의 [column, endColumn) 글(oldText)을 newText로 바꿔요. 줄과 열은 1부터 세요.
 * 열은 UTF-16 단위예요(JavaScript 글의 길이와 같아요).
 */
export interface RenameSite {
  path: string;
  line: number;
  column: number;
  /** 바꿀 글이 끝난 다음 열(포함하지 않음). */
  endColumn: number;
  oldText: string;
  newText: string;
  /**
   * 무엇이 적힌 자리인지: 정의(`definition`), 사용처의 관계 종류(`read`, `call` …),
   * 또는 색인이 잇지 못했지만 정의의 범위 안에 같은 이름의 식별자가 적힌 자리(`unlinked`: 합쳐진 선언 등, 확인해요).
   */
  kind: 'definition' | 'unlinked' | RelationKind;
  role: FileRole;
  /** 이 자리를 감싸는 심볼의 이름. 파일 최상위면 없음. */
  in?: string;
  confidence: Confidence;
  source: string;
}

/** 계획대로 고치면 생길 수 있는 문제. */
export interface RenameWarning {
  /**
   * `conflict`: 새 이름이 같은 범위의 다른 이름과 겹쳐요(같은 타입의 멤버, 같은 파일의 최상위 이름, 고칠 파일이 이미 쓰는 이름, 상속으로 이어진 타입의 멤버).
   * `override`: 상속·구현으로 이어진 타입에 같은 이름의 멤버가 있어요. 함께 바꾸지 않으면 재정의 관계가 끊겨요.
   * `mismatch`: 색인이 알려 준 자리의 글이 옛 이름과 달라 계획에 넣지 않았어요(색인이 낡았거나 색인기의 범위가 다른 경우).
   */
  kind: 'conflict' | 'override' | 'mismatch';
  message: string;
  /** 겹치거나 이어진 이름(바깥 타입을 붙인 이름). mismatch면 없음. */
  name?: string;
  path: string;
  line: number;
  column: number;
  key?: string;
  confidence: Confidence;
  source: string;
}

export interface RenameBody {
  [key: string]: unknown;
  query: string;
  newName: string;
  status: 'found' | 'ambiguous' | 'not_found';
  oldName?: string;
  /** 바꿀 심볼. 보통 하나이고, 추정 층이 getter와 setter를 따로 적었으면 그 짝이에요. */
  targets?: SymbolRow[];
  /** 정밀 층이 알려 준 고칠 자리. 경로, 줄, 열 순. */
  edits?: Page<RenameSite>;
  /** 추정 층이 이은 자리와 구문으로만 찾은 자리(`unlinked`). 이름으로 이은 것이라 확인하고 고쳐요. */
  inferred?: Page<RenameSite>;
  warnings?: Page<RenameWarning>;
  summary?: { files: number; edits: number; inferred: number; warnings: number };
  candidates?: SymbolRow[];
}

const IDENT = '[\\p{L}\\p{N}_$]';

/** getter와 setter처럼 같은 자리(같은 바깥 이름, 같은 파일)의 접근자 짝인지. 이 짝은 함께 바꿔야 해서 모호하지 않아요. */
function accessorPair(candidates: SymbolRow[]): boolean {
  const [first] = candidates;
  return (
    first !== undefined &&
    candidates.every(
      (c) => c.qualifiedName === first.qualifiedName && c.definition.path === first.definition.path && (c.kind === 'getter' || c.kind === 'setter'),
    )
  );
}

export async function rename(store: GraphStore, query: string, newName: string, limit: number): Promise<RenameBody> {
  if (!new RegExp(`^${IDENT}+$`, 'u').test(newName)) {
    throw new UserError(`rename: 새 이름은 식별자 하나여야 해요(점, 공백 없이): ${newName}`);
  }
  const point = resolvePoint(store, query);
  if (point.status === 'file') throw new UserError(`rename: 이름(심볼)을 바꿔요. 파일 이름 바꾸기는 아직 안 돼요: ${query}`);
  if (point.status === 'not_found') return { query, newName, status: 'not_found' };
  let targets: SymbolRow[];
  if (point.status === 'ambiguous') {
    if (!accessorPair(point.candidates)) return { query, newName, status: 'ambiguous', candidates: point.candidates };
    targets = point.candidates;
  } else {
    targets = [point.symbol];
  }
  const oldName = targets[0]!.name;
  if (newName === oldName) throw new UserError(`rename: 새 이름이 지금 이름과 같아요: ${newName}`);

  const root = store.meta().repoRoot;
  const lines = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    let out = lines.get(path);
    if (!out) {
      try {
        out = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
      } catch {
        out = [];
      }
      lines.set(path, out);
    }
    return out;
  };
  const roleOf = (path: string): FileRole => store.findFile(path)?.role ?? 'app';
  const at = (path: string, line: number, column: number) => `${path}:${line}:${column}`;

  // 1) 색인이 알려 준 자리: 정의와 사용처.
  const sites = new Map<string, RenameSite>();
  const warnings: RenameWarning[] = [];
  const add = (site: Omit<RenameSite, 'endColumn' | 'oldText' | 'newText'>) => {
    const text = linesOf(site.path)[site.line - 1] ?? '';
    if (text.slice(site.column - 1, site.column - 1 + oldName.length) !== oldName) {
      warnings.push({
        kind: 'mismatch',
        message: `이 자리의 글이 ${oldName}가 아니라 계획에 넣지 않았어요. 색인이 낡았으면 다시 색인해요.`,
        path: site.path,
        line: site.line,
        column: site.column,
        confidence: site.confidence,
        source: site.source,
      });
      return;
    }
    const id = at(site.path, site.line, site.column);
    const before = sites.get(id);
    if (before && (before.confidence === 'precise' || site.confidence === 'inferred')) return;
    sites.set(id, { ...site, endColumn: site.column + oldName.length, oldText: oldName, newText: newName });
  };
  for (const t of targets) {
    const d = t.definition;
    add({ path: d.path, line: d.line, column: d.column, kind: 'definition', role: roleOf(d.path), confidence: t.confidence, source: t.source });
    for (const u of store.usesOf(t.key, Number.MAX_SAFE_INTEGER).items) {
      add({ path: u.path, line: u.line, column: u.column, kind: u.kind, role: u.role, ...(u.in ? { in: u.in } : {}), confidence: u.confidence, source: u.source });
    }
  }

  // 2) 색인이 잇지 못한 자리: 정의를 품은 범위(멤버면 바깥 타입, 아니면 정의 자신) 안의 같은 이름 식별자.
  //    색인기가 하나로 합친 선언(이름 없는 생성자, getter와 짝인 setter)이 여기서 나와요.
  const defs = store.definitions();
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  for (const t of targets) {
    for (const site of await unlinkedSites(store, t, defByKey.get(t.key)?.parentKey ?? null, oldName, linesOf, sites)) add(site);
  }

  // 3) 경고: 새 이름이 겹치는 곳, 함께 바꾸지 않으면 끊기는 재정의.
  const targetKeys = new Set(targets.map((t) => t.key));
  const editedFiles = new Set([...sites.values()].map((s) => s.path));
  const parentKey = defByKey.get(targets[0]!.key)?.parentKey ?? null;
  const warn = (kind: RenameWarning['kind'], d: SymbolRow, message: string) => {
    if (warnings.some((w) => w.key === d.key && w.kind === kind)) return;
    warnings.push({ kind, message, name: d.qualifiedName, path: d.definition.path, line: d.definition.line, column: d.definition.column, key: d.key, confidence: d.confidence, source: d.source });
  };
  if (parentKey !== null) {
    const related = relatedTypes(store, parentKey);
    for (const d of defs) {
      if (targetKeys.has(d.key) || d.parentKey === null || !related.has(d.parentKey)) continue;
      const own = d.parentKey === parentKey;
      if (d.name === newName) warn('conflict', d, own ? `같은 타입에 ${newName}가 이미 있어요.` : `상속으로 이어진 타입에 ${newName}가 이미 있어요.`);
      else if (d.name === oldName && !own) warn('override', d, `상속으로 이어진 타입의 ${d.qualifiedName}는 바뀌지 않아요. 재정의 관계면 함께 바꿔요.`);
    }
  } else {
    for (const d of defs) {
      if (targetKeys.has(d.key) || d.parentKey !== null || d.name !== newName) continue;
      if (editedFiles.has(d.definition.path)) {
        warn('conflict', d, `고칠 파일 ${d.definition.path}에 최상위 이름 ${newName}가 이미 있어요.`);
        continue;
      }
      const users = new Set(store.usesOf(d.key, Number.MAX_SAFE_INTEGER).items.map((u) => u.path));
      const shared = [...editedFiles].filter((p) => users.has(p)).sort(compareText);
      if (shared.length > 0) warn('conflict', d, `고칠 파일(${shared.join(', ')})이 이미 ${newName}(${d.definition.path})를 써요.`);
    }
  }

  const order = (a: RenameSite, b: RenameSite) => compareText(a.path, b.path) || a.line - b.line || a.column - b.column;
  const all = [...sites.values()].sort(order);
  const edits = all.filter((s) => s.confidence === 'precise');
  const inferred = all.filter((s) => s.confidence === 'inferred');
  const kindOrder = { conflict: 0, override: 1, mismatch: 2 } as const;
  warnings.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || compareText(a.path, b.path) || a.line - b.line || a.column - b.column);
  return {
    query,
    newName,
    status: 'found',
    oldName,
    targets,
    edits: cut(edits, limit),
    inferred: cut(inferred, limit),
    warnings: cut(warnings, limit),
    summary: { files: editedFiles.size, edits: edits.length, inferred: inferred.length, warnings: warnings.length },
  };
}

/** 타입과 상속·구현으로 이어진 타입 전부(조상과 자손, 자기 포함). */
function relatedTypes(store: GraphStore, typeKey: string): Set<string> {
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  for (const e of store.edges({ kinds: ['extends', 'implements'] })) {
    if (!('symbol' in e.from) || !('symbol' in e.to)) continue;
    // 사용처를 감싸는 심볼이 타입의 멤버일 수도 있어서 타입까지 올라가지 않고 그대로 써요(타입 머리의 관계는 타입이 감싸요).
    const sub = e.from.symbol;
    const sup = e.to.symbol;
    if (!up.has(sub)) up.set(sub, new Set());
    up.get(sub)!.add(sup);
    if (!down.has(sup)) down.set(sup, new Set());
    down.get(sup)!.add(sub);
  }
  const out = new Set<string>([typeKey]);
  for (const links of [up, down]) {
    const stack = [typeKey];
    while (stack.length > 0) {
      for (const next of links.get(stack.pop()!) ?? []) {
        if (!out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  }
  return out;
}

/**
 * 정의를 품은 범위(멤버면 바깥 타입의 정의 전체, 아니면 정의 자신의 전체) 안에서 옛 이름과 같은 식별자 가운데
 * 색인이 무엇과도 잇지 않은 자리. 그 언어의 문법으로 읽어 주석과 글(문자열) 안은 빼요. 문법이 없는 언어면 찾지 않아요.
 */
async function unlinkedSites(
  store: GraphStore,
  target: SymbolRow,
  parentKey: string | null,
  oldName: string,
  linesOf: (path: string) => string[],
  known: Map<string, RenameSite>,
): Promise<Omit<RenameSite, 'endColumn' | 'oldText' | 'newText'>[]> {
  const path = target.definition.path;
  const file = store.findFile(path);
  const setup = file ? LANGUAGES.find((l) => l.language === file.language)?.inferred : undefined;
  if (!file || !setup) return [];
  const extents = store.extentsIn(path);
  const ownerKey = parentKey ?? target.key;
  // 바깥 타입이 이 파일에 없으면(다른 파일의 타입을 넓히는 경우 등) 정의 자신의 범위만 봐요.
  const owner = extents.find((e) => e.key === ownerKey) ?? extents.find((e) => e.key === target.key);
  if (!owner) return [];
  const taken = new Set<string>();
  for (const e of extents) taken.add(`${e.definition.line}:${e.definition.column}`);
  for (const r of store.relationSitesIn(path)) taken.add(`${r.line}:${r.column}`);
  for (const s of known.values()) if (s.path === path) taken.add(`${s.line}:${s.column}`);

  const lines = linesOf(path);
  const found: { line: number; column: number }[] = [];
  // 글로는 넉넉히 찾고(앞의 `$`는 글에 끼운 이름의 표시일 수 있어 막지 않아요) 식별자인지는 아래 문법이 가려요.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${oldName.replace(/[$]/g, '\\$')}(?!${IDENT})`, 'gu');
  for (let line = owner.extent.start; line <= owner.extent.end; line++) {
    for (const m of (lines[line - 1] ?? '').matchAll(pattern)) {
      const column = m.index + 1;
      if (!taken.has(`${line}:${column}`)) found.push({ line, column });
    }
  }
  if (found.length === 0) return [];

  const parser = await parserFor(setup.grammarFor?.(path) ?? setup.grammar);
  const tree = parser.parse(lines.join('\n'));
  if (!tree) return [];
  try {
    const enclosing = (line: number): string | undefined => {
      // 자리를 품는 가장 안쪽 정의(감싸는 심볼의 이름).
      let best: (typeof extents)[number] | undefined;
      for (const e of extents) if (e.extent.start <= line && line <= e.extent.end && (!best || e.extent.start >= best.extent.start)) best = e;
      return best?.qualifiedName;
    };
    const out: Omit<RenameSite, 'endColumn' | 'oldText' | 'newText'>[] = [];
    for (const f of found) {
      const node = tree.rootNode.descendantForPosition({ row: f.line - 1, column: f.column - 1 });
      if (!node || node.text !== oldName || !/identifier/.test(node.type) || insideTextOrComment(node)) continue;
      const inName = enclosing(f.line);
      out.push({ path, line: f.line, column: f.column, kind: 'unlinked', role: file.role, ...(inName ? { in: inName } : {}), confidence: 'inferred', source: inferredSource(setup) });
    }
    return out;
  } finally {
    tree.delete();
  }
}

/**
 * 주석이나 글(문자열) 안의 식별자인지. 글에 끼운 식(Dart `$x`·`${x}`, JS `${x}`, Python f-string `{x}`)은 이름이라
 * 글보다 끼운 식(substitution, interpolation)을 먼저 만나면 글 안으로 치지 않아요. 노드 종류 이름은 문법마다 달라 낱말로 봐요.
 */
function insideTextOrComment(node: SyntaxNode): boolean {
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (/substitution|interpolation/.test(n.type)) return false;
    if (/comment|string/.test(n.type)) return true;
  }
  return false;
}

export const renameQuery: QueryDef = {
  name: 'rename',
  description:
    '이름(심볼) 하나를 새 이름으로 바꿀 때 고칠 자리(파일, 줄, 열) 전부를 계획으로 돌려줘요. 파일은 고치지 않아요: 계획대로 고치는 것은 부르는 쪽이에요. ' +
    '정밀 색인기가 알려 준 자리는 edits, 추정 층이 이름으로 이은 자리와 색인이 잇지 못한 같은 이름 식별자(kind: unlinked)는 inferred에 따로 나오니 확인하고 고쳐요. ' +
    '새 이름이 같은 범위의 다른 이름과 겹치거나(conflict) 상속으로 이어진 같은 이름 멤버가 있으면(override) warnings에 나와요. ' +
    '같은 이름이 여럿이면 하나를 고르지 않고 후보(candidates)를 돌려주니, 후보의 qualifiedName이나 key로 다시 물어요.',
  params: [
    {
      name: 'query',
      type: 'string',
      positional: true,
      required: true,
      description: '바꿀 이름. 짧은 이름(withTax), 바깥 타입을 붙인 이름(Money.cents), 심볼 열쇠(key) 중 하나.',
    },
    { name: 'to', type: 'string', required: true, description: '새 이름(식별자 하나. 멤버도 짧은 이름만: Money.cents → amount).' },
    {
      name: 'limit',
      type: 'integer',
      min: 1,
      default: DEFAULT_LIMIT,
      description: '목록(edits, inferred, warnings)마다 앞에서부터 몇 개까지 줄지. 잘렸으면(truncated) 늘려서 다시 물어요.',
    },
  ],
  run: (store, args) => rename(store, args.query as string, args.to as string, args.limit as number),
};
