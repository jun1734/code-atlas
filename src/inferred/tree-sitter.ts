// Tree-sitter 불러오기. 파서(web-tree-sitter)와 문법(@repomix/tree-sitter-wasms)이 모두 WASM이라
// 네이티브 빌드 없이 Windows와 Linux에서 같게 돌아요. 라이선스는 README의 라이선스 방침에 있어요.
import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { Range } from '../facts.ts';

export type { Node as SyntaxNode } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let ready: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();

/**
 * 문법 이름(`@repomix/tree-sitter-wasms/out/tree-sitter-<이름>.wasm`의 <이름>, 예: dart, python, typescript, tsx)으로
 * 그 문법을 쓰는 파서를 만들어요. 파서 초기화와 문법 불러오기는 프로세스에서 한 번만 해요.
 */
export async function parserFor(grammar: string): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let language = languages.get(grammar);
  if (!language) {
    language = Language.load(require.resolve(`@repomix/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`));
    languages.set(grammar, language);
  }
  const parser = new Parser();
  parser.setLanguage(await language);
  return parser;
}

/** 이름 붙은 자식들. */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/** 같은 노드인지. web-tree-sitter는 노드를 꺼낼 때마다 새 객체를 줘서 ===로는 비교할 수 없어요. */
export function same(a: Node | null | undefined, b: Node | null | undefined): boolean {
  return !!a && !!b && a.id === b.id;
}

/** 노드의 자리(0부터 세는 줄과 열, 끝은 포함하지 않아요). */
export function rangeOf(n: Node): Range {
  return { startLine: n.startPosition.row, startColumn: n.startPosition.column, endLine: n.endPosition.row, endColumn: n.endPosition.column };
}
