// 언어 어댑터가 내는 공통 형식의 사실과 어댑터 인터페이스.
// 그래프 저장소와 질의 모듈은 이 형식만 알고, 어느 언어인지는 몰라요.
// 설명은 docs/architecture.md에 있어요.

/** 관계를 얼마나 믿을 수 있는지. 정밀: 컴파일러 수준 색인기, 추정: 이름으로 이은 것. */
export type Confidence = 'precise' | 'inferred';

/** 심볼의 종류 전부. 색인기가 모르는 종류는 'unknown'. 종류 목록이 필요한 곳(search의 kind 검사 등)은 이 배열을 써요. */
export const SYMBOL_KINDS = [
  'file',
  'namespace',
  'class',
  'interface',
  'enum',
  'mixin',
  'extension',
  'type',
  'function',
  'method',
  'constructor',
  'getter',
  'setter',
  'field',
  'variable',
  'constant',
  'parameter',
  'unknown',
] as const;

/** 심볼의 종류. */
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** 타입인 종류(멤버를 가지고 상속·구현의 대상이 될 수 있어요). */
export const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['class', 'interface', 'enum', 'mixin', 'extension', 'type']);

/**
 * 관계의 종류.
 * - import: 파일이 다른 파일을 가져오거나 다시 내보내요(Dart의 export 포함).
 * - read / write / call: 값을 읽거나, 값에 쓰거나, 함수·메서드·생성자를 불러요.
 * - extends / implements: 타입이 다른 타입을 상속하거나(mixin을 섞는 것 포함) 구현해요.
 * - reference: 위 어느 것도 아닌 언급(타입 표기 등). 색인기도 어댑터도 가려 주지 않으면 이것이에요.
 */
export type RelationKind = 'import' | 'reference' | 'read' | 'write' | 'call' | 'extends' | 'implements';

/** 파일의 역할. 테스트 파일인지는 언어 어댑터가 그 언어의 관례로 정해요. */
export type FileRole = 'app' | 'test';

/**
 * 자리 열쇠: 줄과 열을 이은 글. 같은 자리를 견주는 표의 열쇠로 써요(줄·열을 0부터 셌는지 1부터 셌는지는 쓰는 쪽이 한 가지로 맞춰요).
 * 경로까지 붙인 열쇠는 placeKey.
 */
export const positionKey = (line: number, column: number): string => `${line}:${column}`;

/** 경로를 붙인 자리 열쇠. */
export const placeKey = (path: string, line: number, column: number): string => `${path}:${positionKey(line, column)}`;

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
  role: FileRole;
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
  /** 이 타입이 상속하거나 구현하는 타입들의 key(색인기가 알려 줄 때). 바로 위 타입만이 아니라 조상 전체일 수 있어요. */
  supertypes?: string[];
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
  /** 관계가 있다는 것(어디서 무엇을 가리키는지)을 얼마나 믿는지. */
  confidence: Confidence;
  /**
   * 관계의 종류(kind)를 얼마나 믿는지. 색인기가 종류를 알려 줬거나 색인기의 사실로 확인했으면 precise,
   * 어댑터가 소스의 문법(뒤에 오는 괄호, 대입 연산자 등)만으로 가렸으면 inferred.
   */
  kindConfidence: Confidence;
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

/** drop이 참인 파일과, 그 파일에서 정의한 심볼, 그 파일에 적힌 관계, 그 파일로 가는 import를 빼요. */
export function dropFiles(facts: Facts, drop: (path: string) => boolean): Facts {
  return {
    files: facts.files.filter((f) => !drop(f.path)),
    symbols: facts.symbols.filter((s) => !drop(s.path)),
    relations: facts.relations.filter((r) => !drop(r.from.path) && !('path' in r.to && drop(r.to.path))),
  };
}

export interface RepoInfo {
  /** 저장소 뿌리의 절대 경로. */
  root: string;
  /** git이 추적하는 파일 목록(상대 경로, '/' 구분). git 저장소가 아니면 null. */
  trackedFiles: string[] | null;
}

/** 커밋 색인이 지금 작업 트리에서 빌려 오는 도구 상태 파일 한 묶음(보통 패키지 하나). */
export interface ToolState {
  /** 빌려 올 파일(저장소 기준 경로, '/' 구분). 작업 트리에 없는 것은 건너뛰어요. */
  files: string[];
  /**
   * 빌린 파일이 그 커밋에도 맞는지 가르는 파일(잠금 파일 등, 저장소 기준 경로). 하나라도 커밋과 작업 트리에서 내용이 다르면
   * 빌린 것이 그 커밋에 맞는지 몰라서, 그 커밋 색인에서 이 색인기가 낸 사실은 추정(inferred)으로 낮춰요.
   * git이 무시하는 파일은 없는 것으로 봐요.
   */
  sameAs: string[];
}

/** 언어 하나를 맡는 어댑터. 저장소를 받아 공통 형식의 사실을 내요. */
export interface LanguageAdapter {
  /** 어댑터(색인기) 이름. 관계의 source로 남아요. */
  readonly name: string;
  readonly language: string;
  /** 색인기를 설치하는 명령(색인기가 없을 때 안내에 써요). 예: 'dart pub global activate scip_dart 1.8.1' */
  readonly install: string;
  /** 이 저장소에 이 언어가 있는지. */
  applies(repo: RepoInfo): boolean;
  /**
   * 심볼 열쇠의 패키지 이름이 언어 기본 라이브러리(SDK)인지. 코드 지도의 "외부 SDK가 닿는 파일"에서 빼요.
   * 예: scip-dart는 `dart:async`를 패키지 이름으로 적어요.
   */
  isStandardLibrary(pkg: string): boolean;
  /**
   * 색인기가 읽지만 git이 무시해서 커밋에는 없는 파일(패키지 설정 등)의 묶음. 커밋 색인(src/snapshot.ts)이 그 커밋을 꺼낸 뒤
   * 지금 작업 트리의 같은 자리에서 빌려 와요. repo는 꺼낸 커밋이에요(trackedFiles는 그 커밋의 파일). 없으면 빈 배열.
   */
  toolState(repo: RepoInfo): ToolState[];
  /**
   * 저장소를 색인해 사실을 내요. 저장소의 추적 파일을 바꾸면 안 돼요.
   * 임시 파일은 workDir(저장소 밖)에 써요.
   * 색인기가 설치되어 있지 않으면 IndexerMissing을 던져요. 그 밖의 실패는 보통의 오류예요.
   * 어느 쪽이든 색인기(src/indexer.ts)는 그 언어를 추정 층으로 색인하고 멈추지 않아요.
   */
  index(repo: RepoInfo, workDir: string): Promise<Facts>;
}

/** 정밀 색인기가 설치되어 있지 않아요. message에는 무엇이 없는지, install에는 설치 명령이 있어요. */
export class IndexerMissing extends Error {
  readonly install: string;
  constructor(message: string, install: string) {
    super(message);
    this.name = 'IndexerMissing';
    this.install = install;
  }
}
