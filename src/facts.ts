// 언어 어댑터가 내는 공통 형식의 사실과 어댑터 인터페이스.
// 그래프 저장소와 질의 모듈은 이 형식만 알고, 어느 언어인지는 몰라요.
// 설명은 docs/architecture.md에 있어요.

/** 관계를 얼마나 믿을 수 있는지. 정밀: 컴파일러 수준 색인기, 추정: 이름으로 이은 것. */
export type Confidence = 'precise' | 'inferred';

/** 심볼의 종류. 색인기가 모르는 종류는 'unknown'. */
export type SymbolKind =
  | 'file'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'enum'
  | 'mixin'
  | 'extension'
  | 'type'
  | 'function'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'field'
  | 'variable'
  | 'constant'
  | 'parameter'
  | 'unknown';

/** 관계의 종류. 색인기가 읽기/쓰기를 가려 주지 않으면 'reference'. */
export type RelationKind = 'import' | 'reference' | 'read' | 'write' | 'call' | 'extends' | 'implements';

/** 0부터 세는 줄과 열. 끝은 포함하지 않아요. */
export interface Range {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface FileFact {
  /** 저장소 뿌리에서의 상대 경로. 구분자는 항상 '/'. */
  path: string;
  language: string;
}

export interface SymbolFact {
  /** 저장소 안에서 이 심볼을 하나로 가리키는 열쇠(SCIP 심볼 문자열 등). OS와 무관해야 해요. */
  key: string;
  /** 짧은 이름. 예: total */
  name: string;
  /** 바깥 타입을 붙인 이름. 예: Cart.total */
  qualifiedName: string;
  kind: SymbolKind;
  /** 정의가 있는 파일 경로. */
  path: string;
  /** 이름이 적힌 자리. */
  range: Range;
  /** 정의 전체(본문 포함)의 자리. 사용처를 감싸는 심볼을 찾는 데 써요. */
  enclosingRange?: Range;
  /** 바로 바깥 심볼의 key(메서드라면 클래스). */
  parentKey?: string;
  confidence: Confidence;
  /** 이 심볼을 낸 색인기 이름. 예: scip-dart */
  source: string;
}

export interface RelationFact {
  kind: RelationKind;
  /** 관계가 적힌 자리. */
  from: { path: string; range: Range; symbolKey?: string };
  /** 가리키는 대상. 심볼 또는 파일(import). */
  to: { symbolKey: string } | { path: string };
  confidence: Confidence;
  /** 이 관계를 낸 색인기 이름. 예: scip-dart */
  source: string;
}

export interface Facts {
  files: FileFact[];
  symbols: SymbolFact[];
  relations: RelationFact[];
}

export function emptyFacts(): Facts {
  return { files: [], symbols: [], relations: [] };
}

/** part의 사실을 into 뒤에 붙여요. */
export function appendFacts(into: Facts, part: Facts): void {
  into.files.push(...part.files);
  into.symbols.push(...part.symbols);
  into.relations.push(...part.relations);
}

export interface RepoInfo {
  /** 저장소 뿌리의 절대 경로. */
  root: string;
  /** git이 추적하는 파일 목록(상대 경로, '/' 구분). git 저장소가 아니면 null. */
  trackedFiles: string[] | null;
}

/** 언어 하나를 맡는 어댑터. 저장소를 받아 공통 형식의 사실을 내요. */
export interface LanguageAdapter {
  /** 어댑터(색인기) 이름. 관계의 source로 남아요. */
  readonly name: string;
  readonly language: string;
  /** 이 저장소에 이 언어가 있는지. */
  applies(repo: RepoInfo): boolean;
  /**
   * 저장소를 색인해 사실을 내요. 저장소의 추적 파일을 바꾸면 안 돼요.
   * 임시 파일은 workDir(저장소 밖)에 써요.
   */
  index(repo: RepoInfo, workDir: string): Promise<Facts>;
}
