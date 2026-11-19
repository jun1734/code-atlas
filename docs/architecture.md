# 구조: 그래프 스키마와 언어 어댑터

```
저장소 ──▶ 언어 어댑터(언어마다 하나) ──▶ 사실(Facts) ──▶ 그래프 저장소(SQLite) ──▶ 질의(context …) ──▶ 실행기(봉투) ──▶ 명령줄 / MCP
```

언어를 아는 곳은 어댑터뿐이에요. 그래프 저장소와 질의는 공통 형식의 사실만 알아요. 새 언어는 어댑터 하나와 예제 저장소 하나를 더해 붙여요.
새 질의는 `QueryDef` 하나를 `QUERIES`에 더해 붙여요. 명령줄과 MCP는 고치지 않아요(아래 "질의 실행기와 바깥 껍데기").

## 언어 어댑터 인터페이스

정의: `src/facts.ts`의 `LanguageAdapter`.

```ts
interface LanguageAdapter {
  readonly name: string;                 // 색인기 이름. 관계의 source로 남아요. 예: 'scip-dart'
  readonly language: string;             // 예: 'dart'
  applies(repo: RepoInfo): boolean;      // 이 저장소에 이 언어가 있는지
  index(repo: RepoInfo, workDir: string): Promise<Facts>;
}

interface RepoInfo {
  root: string;                    // 저장소 뿌리 절대 경로
  trackedFiles: string[] | null;   // git 추적 파일('/' 구분). git 저장소가 아니면 null
}
```

어댑터가 지킬 것:

- 저장소의 추적 파일을 바꾸지 않아요. 임시 산출물은 `workDir`(저장소 밖)에 써요.
- 네트워크를 쓰지 않아요. 패키지 설치(`pub get`, `npm install` 등)가 필요하면 대신 돌리지 않고 할 일을 알려 줘요.
- 경로는 저장소 뿌리 기준 상대 경로, 구분자는 항상 `/`예요.
- 심볼 열쇠(`key`)는 저장소 안에서 심볼 하나를 가리키고, OS에 따라 달라지지 않아요.
- 색인기가 없으면 설치 방법을 담은 오류를 내요.

두 종류가 있어요.

- **정밀 어댑터**: 그 언어의 SCIP 색인기를 돌리고 `src/scip/to-facts.ts`로 SCIP 색인을 사실로 옮겨요. `confidence: 'precise'`. 지금은 Dart(`src/adapters/dart.ts`, scip-dart)만 있어요.
- **추정 어댑터**(뒤 티켓): Tree-sitter로 구문을 읽고 이름으로 이어요. `confidence: 'inferred'`.

### 사실(Facts)

```ts
interface Facts {
  files: { path: string; language: string; role: 'app' | 'test' }[]; // role: 테스트 파일인지(어댑터가 언어 관례로 정해요)
  symbols: SymbolFact[];
  relations: RelationFact[];
}

interface SymbolFact {
  key: string;            // 예: 'scip-dart pub dart_sample 1.0.0 lib/src/`cart.dart`/Cart#total().'
  name: string;           // 'total'
  qualifiedName: string;  // 'Cart.total' (바깥 타입을 붙인 이름. 파일·폴더는 넣지 않아요)
  kind: SymbolKind;       // function, method, class, field, variable, constant, getter, …
  path: string;           // 정의가 있는 파일
  range: Range;           // 이름이 적힌 자리(0부터)
  enclosingRange?: Range; // 정의 전체(본문 포함). 사용처를 감싸는 심볼을 찾을 때 써요
  parentKey?: string;     // 바로 바깥 심볼(메서드라면 클래스)
  supertypes?: string[];  // 타입이 상속·구현하는 타입들(색인기가 알려 줄 때, 조상 전체일 수 있어요). 그래프에는 넣지 않아요
  confidence: 'precise' | 'inferred';
  source: string;         // 낸 색인기
}

interface RelationFact {
  kind: 'import' | 'reference' | 'read' | 'write' | 'call' | 'extends' | 'implements';
  from: { path: string; range: Range; symbolKey?: string }; // 적힌 자리와 감싸는 심볼
  to: { symbolKey: string } | { path: string };             // 심볼 또는 파일(import)
  confidence: 'precise' | 'inferred';     // 관계가 있다는 것(어디서 무엇을)을 믿는 정도
  kindConfidence: 'precise' | 'inferred'; // 종류(kind)를 믿는 정도. 색인기가 알려 줬거나 색인기의 사실로 확인했으면 precise, 문법으로만 가렸으면 inferred
  source: string;
}
```

관계 종류의 뜻: `import`(파일을 가져오거나 다시 내보냄), `read`/`write`/`call`(값을 읽음, 값에 씀, 함수·메서드·생성자를 부름), `extends`(상속, mixin을 섞는 것 포함)/`implements`(구현), `reference`(그 밖의 언급: 타입 표기 등).

### 기본으로 빼는 파일

- git이 무시하는 파일(`git ls-files --others --ignored --exclude-standard --directory`)은 어느 언어든 색인기(`src/indexer.ts`)가 빼요(`dropFiles`).
- 생성된 코드와 빌드 산출물은 언어마다 달라서 어댑터가 빼요. 뺀 파일의 정의, 그 파일에 적힌 사용처, 그 파일로 가는 import가 같이 빠져요. 다른 파일에서 뺀 파일의 이름을 쓰는 곳은 남고, 그 이름은 저장소 밖 심볼처럼 `symbols`에 없어요.

SCIP에서 옮기는 규칙(`src/scip/to-facts.ts`):

- 정의: `Definition` 역할이 붙은 occurrence. 종류는 `SymbolInformation.kind`, 없으면 심볼 문자열 꼬리(`().` 함수, `#` 타입, `.` 값)로 짐작해요.
- 사용처: 그 밖의 occurrence. 같은 파일에서 `enclosingRange`가 사용처를 품는 정의 중 가장 안쪽 것을 `from.symbolKey`로 둬요.
- 관계 종류: SCIP 역할의 `Import`/`WriteAccess`/`ReadAccess`를 따르고, 아무것도 없으면 `reference`예요(`kindConfidence: 'precise'`). 어댑터가 뒤에서 더 가를 수 있어요.
- 타입의 `SymbolInformation.relationships` 중 `is_implementation`은 `supertypes`가 돼요.
- 파일 자체를 가리키는 심볼(`` …/`lib/a.dart`/ ``)에 대한 occurrence(import/export 지시문)는 파일→파일 `import` 관계가 돼요.
- `local N` 심볼(지역 변수)은 넣지 않아요. scip-dart 1.8.1은 비공개 선언(`_`로 시작하는 클래스, 함수 등)도 `local` 심볼로 적어서 그것들은 그래프에 없어요(그 멤버는 있어요).
- 파일의 `role`은 `app`으로 두고, 어댑터가 고쳐요.

### Dart 어댑터가 더 하는 일

`src/adapters/dart-refine.ts`. scip-dart 1.8.1이 주지 않는 것을 Dart 관례와 소스 글로 채워요.

- **빼는 파일**: 패키지 뿌리의 `build/`, `.dart_tool/`, 꼬리가 `.g.dart`·`.freezed.dart`·`.mocks.dart`·`.gr.dart`·`.gen.dart`인 파일, 머리(앞 1000자)에 `GENERATED CODE - DO NOT MODIFY BY HAND`나 `// @generated`가 있는 파일.
- **테스트 파일**: 패키지 뿌리의 `test/`, `integration_test/`, `test_driver/` 아래이거나 이름이 `_test.dart`로 끝나면 `role: 'test'`.
- **열쇠 맞추기**: 이름 없는 생성자(`` Cart#`<constructor>`(). ``)는 클래스(`Cart#`)로 합쳐요. `Cart()`는 클래스 `Cart`를 부르는 곳(`call`)으로 나와요. getter·setter(`` `<get>label`. ``)는 그 이름(`label.`)으로 합치고 종류를 `getter`/`setter`로 둬요. 이름 있는 생성자(`Cart.empty`)는 그대로예요.
- **상수**: 선언문의 이름 앞에 `const`가 있는 변수·필드는 `constant`예요(scip-dart는 `Variable`로 줘요).
- **인터페이스**: 선언문의 이름 바로 앞이 `abstract interface class`인 클래스는 `interface`예요(scip-dart 1.8.1은 `Class`로 줘요. `mixin`은 scip-dart가 `Mixin`으로 줘서 그대로예요). 그냥 `interface class`는 만들 수 있는 클래스라 `class`로 둬요.
- 상수와 인터페이스의 종류는 선언문의 열쇠말(Dart 문법이 정한 꼴)로 가려서 심볼의 `confidence`는 그대로 `precise`예요. 사용처의 종류(아래)처럼 앞뒤 글로 짐작하는 것이 아니라, 정의 자체는 scip-dart가 준 것이고 열쇠말은 선언에 그대로 적혀 있어서요.
- **사용처의 종류**: scip-dart 1.8.1은 읽기/쓰기 역할을 주지 않아서(모두 역할 없음) 소스의 문법으로 가려요.
  - `extends`/`implements` (`kindConfidence: 'precise'`): 감싸는 타입의 머리(이름 뒤, `{` 앞)에 있고, 그 타입의 `supertypes`(scip-dart가 준 사실)에 대상이 있을 때만. 바로 앞의 열쇠말이 `extends`·`with`면 `extends`, `implements`·`on`(mixin의 `on`)이면 `implements`예요.
  - `call` (`inferred`): 이름 뒤(타입 인자 `<…>`를 건너뛰고) 바로 `(`가 와요.
  - `write` (`inferred`): 값(`.`으로 끝나는 열쇠)이나 메서드 뒤에 대입 연산자(`=`, `+=`, `??=` 등)나 `++`/`--`가 오거나, 앞에 `++`/`--`가 있어요.
  - `read` (`inferred`): 그 밖의 값·메서드(함수를 값으로 넘기는 tear-off 포함).
  - `reference` (`inferred`): 그 밖의 타입 언급(타입 표기, `find.byType(X)` 등).
- **`part of` 빼기** (`src/adapters/dart.ts`의 `dropPartOf`): `part of 'a.dart';` 지시문은 scip-dart가 a.dart로 가는 import처럼 적지만 넣지 않아요. part 파일은 a.dart와 한 라이브러리라 기대는 방향이 아니고, a.dart의 `part` 지시문이 이미 이어 줘요. 넣으면 라이브러리마다 서로 물린 파일 묶음이 생겨요.

## 그래프 스키마

정의: `src/graph/store.ts`. SQLite 파일 하나, 저장소 밖에 둬요.

| 표 | 열 | 뜻 |
| --- | --- | --- |
| `meta` | `key`, `value` | `schema`(스키마 버전), `repoRoot`, `commit`(색인 기준 커밋), `worktree`(색인할 때의 작업 트리 지문), `indexedAt` |
| `files` | `id`, `path`, `language`, `role`, `hash` | 파일 노드. `role`은 `app` 또는 `test`, `hash`는 그 파일의 사실 전체의 해시(역할 포함) |
| `symbols` | `id`, `key`, `name`, `qualified_name`, `kind`, `file_id`, `line`, `col`, `end_line`, `end_col`, `parent_key`, `confidence`, `source` | 심볼 노드와 정의 위치(0부터) |
| `relations` | `id`, `kind`, `from_file_id`, `from_symbol_key`, `line`, `col`, `end_line`, `end_col`, `to_symbol_key`, `to_path`, `confidence`, `kind_confidence`, `source` | 간선. 대상은 `to_symbol_key`(심볼) 또는 `to_path`(import한 파일의 경로) |

- 모든 간선과 심볼에 신뢰도(`precise`/`inferred`)와 출처(색인기)가 있어요.
- `to_symbol_key`는 저장소 밖 심볼(예: `dart:core`의 `print`)도 가리킬 수 있어요. 그런 심볼은 `symbols`에 없어요.
- 스키마 버전은 `3`이에요(#212가 `files.role`, `relations.kind_confidence`를 더했어요).
- 바깥에 보이는 것은 열고 닫기(`open`, `openExisting`, `close`), 넣기(`applyFacts(facts, meta)`), 질의 함수뿐이에요. 스키마를 바꿔도 질의 함수의 답이 같으면 테스트는 그대로 통과해요.
  - `meta()`, `counts()`, `languages()`
  - `findSymbols(query)`: 이름으로 심볼 찾기.
  - `usesOf(key, limit, filter?)`: 사용처와 전체 개수, 역할별 개수(`byRole`). 앱 코드가 먼저, 테스트가 뒤에 와요. 각 항목에 `role`, `kind`, `kindConfidence`. `filter: { roles?: ('app'|'test')[], kinds?: RelationKind[] }`로 고르면 개수도 고른 것만 세요(impact의 테스트 목록은 `roles: ['test']`, trace의 호출만 따라가기는 `kinds: ['call']`).
  - `findFile(path)`: 파일 하나(`path`, `language`, `role`).
  - `definedIn(path)`: 파일이 정의하는 심볼.
  - `importsOf(path)`, `importersOf(path)`: 파일이 가져오는(다시 내보내는) 파일, 파일을 가져오는 파일.
  - `usersOf(path)`: 파일이 정의한 이름을 쓰는 다른 파일과 사용처 수. 이름으로 이어서 barrel을 거친 곳도 나와요.
  - `filePaths()`, `definitions()`(정의 전부와 바로 바깥 심볼 `parentKey`), `referencedKeys()`(사용처가 있는 열쇠): 저장소 전체를 훑는 검사(check)용.
- `open`은 스키마 버전이 다른 옛 색인을 비우고 새로 만들어요. 그러면 다음 넣기가 처음부터 색인이 돼요.

### 증분 반영

색인기는 늘 저장소 전체를 돌리고(SCIP 색인기는 대개 프로젝트 단위로 돌아요), 그래프에는 사실이 달라진 파일만 반영해요(`applyFacts`, 한 트랜잭션).

- 사실을 파일별로 나눠요. 파일의 사실은 파일 자신(경로, 언어, 역할), 그 파일에 정의된 심볼, 그 파일에 적힌(나가는) 관계예요.
- 파일마다 그 사실 전체의 해시(`files.hash`)를 둬요. 해시가 같은 파일은 건드리지 않고, 다른 파일은 그 파일의 심볼과 관계를 지우고 다시 넣어요. 사실에서 사라진 파일은 빼요.
- 해시는 파일 내용이 아니라 사실에서 내요. 파일 이름을 바꾸면 그 파일의 심볼 열쇠가 바뀌어서, 내용이 그대로인 다른 파일(barrel을 거쳐 쓰는 파일 등)의 관계도 바뀌기 때문이에요. 거꾸로 주석만 고친 파일은 사실이 같아서 반영하지 않아요.
- import 관계의 대상은 파일 id가 아니라 경로(`to_path`)로 둬요. 대상 파일이 빠지거나 새로 생겨도 그 관계를 가진 파일을 다시 넣을 필요가 없어요.
- 몇 개를 더하고(added), 바꾸고(modified), 빼고(removed), 두었는지(unchanged)를 돌려줘요. `index` 명령의 요약(`changes`)에 그대로 나와요.

### 색인 요약 (`index` 명령의 출력)

`src/indexer.ts`의 `IndexSummary`. JSON이에요.

| 칸 | 뜻 |
| --- | --- |
| `files`, `symbols`, `relations` | 색인한 뒤 그래프 전체의 파일·이름(심볼)·관계 수 |
| `languages.<언어>` | 언어별 `files`, `symbols`, `relations`, 관계 중 정밀(`precise`)·추정(`inferred`) 비율(0~1, 관계가 없으면 `null`). 심볼과 관계의 언어는 적힌 파일의 언어예요 |
| `changes` | 이번에 그래프에 반영한 파일 수(`added`, `modified`, `removed`, `unchanged`). 처음 색인이면 모두 `added` |
| `ms` | 걸린 시간(밀리초). `indexers`(색인기 실행), `graph`(그래프 반영), `total`(전체) |
| `repo`, `db`, `commit`, `adapters`, `dbBytes` | 저장소, 색인 파일, 기준 커밋, 돈 색인기, 색인 파일 크기 |

## 질의: context

`src/query/context.ts`. 물은 글이 색인된 파일 경로와 정확히 맞으면(`\`는 `/`로 바꿔요) 파일 답을 내요. 아니면 이름을 `key` → `qualifiedName` → `name` 순으로 찾고, 처음 맞는 단계의 결과를 써요. 파일과 매개변수(`kind`가 `file`, `parameter`)는 이름으로 찾지 않아요.

답의 봉투(`index`: 저장소, 기준 커밋, 낡음)는 실행기가 씌워요. 계약은 [contract.md](contract.md)에 있어요.

봉투의 `stale`은 HEAD가 색인 커밋과 다르거나 작업 트리가 색인할 때와 다르면 `true`예요(`src/freshness.ts`). 색인은 작업 트리를 읽으니 고친 채로 색인했다면 낡지 않았어요. 그래서 색인할 때 `git status`에 나오는 파일들의 상태와 내용으로 지문(`meta.worktree`)을 남기고, 물을 때 다시 재서 비교해요.

- 하나: `status: 'found'`, 정의와 사용처(`uses`: 앞에서부터 `limit`개, `total`, `truncated`, 역할별 개수 `byRole`). 사용처마다 `role`(`app`/`test`), `kind`, `kindConfidence`, 감싸는 심볼 `in`.
- 파일: `status: 'found'`, `file`(`path`, `language`, `role`), `defines`(정의하는 이름), `imports`(가져오거나 다시 내보내는 파일), `importedBy`(가져오는 파일), `usedBy`(이름을 쓰는 파일과 `uses` 수, barrel을 거친 것 포함). 넷 다 `Page`예요.
- 여럿: `status: 'ambiguous'`, `candidates`. 하나를 골라 그 `qualifiedName`이나 `key`로 다시 물어요.
- 없음: `status: 'not_found'`.

## 질의: search

`src/query/search.ts`. 정확한 이름을 몰라도 시작점을 찾아요. 그래프 탐색은 쓰지 않아요.

- 후보는 `GraphStore.searchCandidates({ kinds?, languages?, folder? })`: 정의된 심볼(파일, 매개변수 제외)과 정의 파일의 `language`·`role`을 SQL로 거른 것이에요. 폴더는 `f.path LIKE '<폴더>/%'`라 그 아래 파일 전부가 맞고, 앞부분만 같은 다른 폴더는 맞지 않아요.
- 이름 맞추기는 질의가 해요. 대소문자를 가리지 않고 이름(`name`) 안에 들어 있으면 맞아요. 아니면 낙타 표기 조각: 질의를 대문자마다 조각으로 쪼개(`cartProv` → cart, prov / `GC` → g, c) 이름의 낱말(`cartProvider` → cart, Provider; `_`, 숫자, 대문자 묶음도 낱말 경계) 머리에 차례로 맞춰요. 건너뛰는 낱말이 있어도 돼요. 질의에 점(`.`)이 있으면 `qualifiedName`에서 이름 일부로 찾아요. 질의가 없으면 조건에 맞는 심볼 전부예요.
- 정렬: 사용처 수(`GraphStore.useCounts()`, context의 `uses.total`과 같은 수)가 많은 순, 같으면 경로·줄·열 순.
- 답: `query`, 실제로 건 `filters`(`kind`, `language`, `folder`), `results`(`Page`). 항목은 `key`, `name`, `qualifiedName`, `kind`, `definition`, `language`, `role`, `uses`, `confidence`, `source`예요. `key`는 context에 그대로 넘기면 그 심볼 하나를 찾아요(context가 `key`부터 찾아요).
- 모르는 `kind`는 쓸 수 있는 종류를 담은 오류(`UserError`)예요. 임베딩 기반 의미 검색은 하지 않아요.

## 저장소 설정과 모듈

모듈은 "파일 경로 → 모듈 이름"이에요. check(흐름, 층), impact(모듈별 묶음), clusters(여러 모듈에 걸침)가 모두 같은 함수를 써요.

- `src/repo-config.ts`: `loadRepoConfig(repoRoot, explicitPath?)`가 저장소 뿌리의 `.code-atlas.json`(명령줄 `--config`, MCP `config` 인자로 다른 파일)을 읽어 `RepoConfig`를 돌려줘요. 파일이 없으면 기본 설정(뿌리 바로 아래 폴더 하나가 모듈 하나)이에요. `readAllowlist(repoRoot, source)`는 허용 목록 하나의 대상 파일을 읽어요.
- `src/modules.ts`: `moduleResolver(config)`가 `(path) => 모듈 이름 | null` 함수를 만들어요. `null`은 어느 규칙에도 맞지 않는 파일(검사 밖)이에요. `globToRegExp`, `nameGlobToRegExp`도 여기 있어요.

`.code-atlas.json` 형식(칸은 모두 선택, 빠지면 기본값):

```jsonc
{
  // 앞에서부터 처음 맞는 규칙이 모듈을 정해요. glob: `*` 한 칸 안, `**` 여러 칸, `{module}` 한 칸을 모듈 이름으로 잡음.
  "modules": [
    { "path": "lib/features/{module}/**" },
    { "path": "lib/shared/**", "module": "shared" },
    { "path": "lib/**", "module": "app" }
  ],
  "shared": ["shared"],          // 모두가 쓰라고 둔 모듈: 다른 모듈이 가져다 써도 리뷰 후보가 아님
  "composers": ["app"],          // 조립하는 모듈: 이 모듈이 가져다 쓰는 것은 리뷰 후보가 아님
  "allowlist": {                 // 흐름을 거슬러도 된다고 적어 둔 (가져다 쓰는 쪽, 대상 파일) 목록. 가져다 쓰는 쪽마다 다르면 배열로 여럿
    "from": { "modules": ["shared"], "files": [] },          // 필수: 이 목록의 대상을 가져다 써도 되는 모듈 이름이나 파일 glob
    "file": "tool/boundaries.dart",                         // 저장소 뿌리 기준
    "block": "const sharedMayImport = \\{([\\s\\S]*?)\\};", // 선택: 이 정규식의 첫 묶음만 읽음
    "item": "'([^']+)'",                                    // 항목마다 첫 묶음 = 경로(없으면 줄마다 하나)
    "items": []                                             // 선택: 목록을 바로 적기
  },
  "openToOtherModules": {        // 다른 모듈에서 가져다 써도 되는 파일(화면, provider 등)
    "files": ["**/*_page.dart"],
    "symbols": [{ "kinds": ["class"], "name": "*Page" }, { "kinds": ["variable"], "name": "*Provider" }]
  },
  "unused": { "private": "_*", "ignore": ["main"] } // 비공개 이름 모양, 일부러 뺄 이름(진입점 등)
}
```

hijo_app의 설정 예는 `test/hijo_app/code-atlas.json`이에요(허용 목록을 `import_boundaries_test.dart`의 `commonMayImport`에서 읽어요).

## 질의: check

`src/query/check.ts`. 저장소 설정으로 검사 안 파일(모듈 규칙에 맞는 파일)을 고르고, 그 사이의 import(`importsOf`), 정의(`definitions`), 쓰인 열쇠(`referencedKeys`)로 답해요.

- `cycles`: 검사 안 파일의 강연결 요소(Tarjan) 가운데 둘 이상인 것. 큰 것부터, 같으면 첫 파일 이름순.
- `modules`: 모듈 그래프(간선 무게 = 모듈 사이 import 수)의 강연결 요소를 위상 순서로 세우고, 서로 도는 묶음 안에서는 흐름을 거스르는 import 수가 가장 적은 순서를 부분집합 DP로 찾아요(묶음이 22개를 넘으면 받은 순서로 두고 `summary.minimal: false`). 위가 가져다 쓰는 쪽이에요. 층(`layer`)은 흐름을 거스르는 간선을 뺀 뒤 맨 아래에서의 가장 긴 거리예요.
- `backwardImports`: 그 순서에서 아래 모듈이 위 모듈을 가져다 쓰는 import. 허용은 (가져다 쓰는 쪽, 대상) 쌍이에요: 가져다 쓰는 파일이나 그 모듈이 허용 목록의 `from`에 맞고 대상이 그 목록에 있으면 `allowed: true`, 아니면 새 위반이에요. 다른 모듈이 같은 대상을 거꾸로 가져오면 새 위반이에요.
- `reviewCandidates`: 다른 모듈의 파일을 가져다 쓰되, 대상 모듈이 `shared`가 아니고, 가져다 쓰는 쪽이 `composers`가 아니고, 대상 파일이 `openToOtherModules`(파일 glob, 또는 그 파일이 정의한 심볼의 이름·종류)에 맞지 않는 것. 판정이 아니라 리뷰 후보예요.
- `unusedPublicNames`: 검사 안 파일의 최상위 선언 가운데, 이름이 `unused.private`에 맞지 않고, 그것과 그 안의 것(생성자, 멤버) 어느 것도 어디서도(테스트 포함) 쓰이지 않은 것. 멤버 하나하나는 보지 않아요: 프레임워크가 부르는 재정의(`build` 등)를 아직 가려내지 못해요. 정의가 없는 사용처 열쇠는 열쇠에서 바깥 타입(`C#`)을 잘라 올라가요.
- 목록(`cycles`, `backwardImports`, `reviewCandidates`, `unusedPublicNames`)은 `Page`예요(`limit`). 묶음 안의 `files`·`imports`도 같은 `limit`으로 잘리는 안쪽 목록(`InnerList`, 모양은 `Page`와 같음)이에요. 항목의 `confidence`는 그 항목을 이룬 import 가운데 가장 낮은 것, `source`는 낸 색인기들이에요. `modules`는 모듈 수만큼이라 자르지 않아요. `summary`에 각 개수와 허용(`allowed`)·새 위반(`new`) 수가 있어요.

hijo_app 7ba0197로 맞춰 보기: `HIJO_APP_REPO=<hijo_app 저장소> npm run verify:hijo`(`test/hijo_app/`). 무거워서 기본 `npm test`에는 넣지 않았어요.

## 질의: impact

`src/query/impact.ts`. 이름이나 파일을 바꾸면 영향 받는 곳이에요. 그래프를 올려(`Graph.load`) 출발점에서 `graph.reach(starts, 'in', depth)`로 쓰는 쪽을 거슬러 올라가요.

- 출발점: 물은 글이 색인된 파일 경로면 `graph.fileNodes(path)`(파일과 그 파일이 정의한 이름). 아니면 context처럼 `findSymbols`(key → qualifiedName → name)로 찾고, 여럿이면 `ambiguous`와 후보, 없으면 `not_found`. 찾은 심볼에 그 안에 정의된 것(멤버, 생성자: `parentKey` 사슬이 그 심볼에 닿는 것)을 더해요. 클래스를 바꾸면 멤버를 쓰는 곳도 영향 받으니까요.
- 영향 받는 곳(`affected`, `Page`): 도착점마다 하나. 사용처를 감싸는 심볼이고, 파일 최상위에서 쓰면(import 등) 그 파일(`kind: 'file'`)이에요. 칸은 `distance`(직접 쓰면 1), `module`(저장소 설정의 모듈, 규칙 밖이면 `null`), `role`, 심볼이면 `line`·`uses`(사용처 수)·`hot`, 그리고 `via`(바꾼 쪽으로 한 단계 다가가며 쓰는 것의 이름, 관계 종류, 적힌 자리). `confidence`는 reach가 준 길의 신뢰도(길에 추정 관계가 하나라도 있으면 `inferred`), `source`는 `via` 관계를 낸 색인기예요. 순서는 거리, 경로, 줄(파일 노드가 먼저), 이름.
- `modules`: 모듈별 묶음(`affected`, 가장 가까운 거리 `nearest`, 그 가운데 테스트 `tests`). 가까운 모듈부터, 같으면 많은 것, 이름 순, 모듈 밖(`null`)은 뒤. 모듈 수만큼이라 자르지 않아요.
- `tests`(`Page`): 영향 받는 곳이 든 테스트 파일(`role: 'test'`)과 가장 가까운 거리. 그 파일의 항목 가운데 하나라도 정밀하면 `precise`.
- `summary`: `depth`, `affected`, 거리별 개수 `byDistance`, `moreBeyondDepth`(depth 다음 단계에도 닿는 곳이 있는지: reach를 한 단계 더 돌려 봐요), 모듈 수, 테스트 파일 수, 이번 hot 기준 `hotUses`.
- 모듈은 check와 같은 `moduleResolver(loadRepoConfig(repoRoot, config))`예요(`--config`, MCP `config`).

**많이 쓰이는 이름(hot)의 기준:** `GraphStore.useCounts()`의 사용처 수(어느 종류의 관계든, 테스트 포함, 같은 줄에 여러 번이면 여러 번)가 **20 이상**이면 `hot: true`예요(`DEFAULT_HOT_USES`). 인자 `hot`으로 저장소마다 바꿔요. 물은 심볼은 `target.uses`·`target.hot`, 파일을 물으면 `target.hotNames`(그 파일이 정의한 hot 이름)로 나와요. 20은 "한 화면에 다 못 보는 정도"로 잡은 값이에요. 이름을 바꿀 때 손으로 고치기 힘들고 리뷰가 커지는 경계예요.

## 질의: clusters

`src/query/clusters.ts`. 서로 촘촘히 엮인 이름들의 묶음이에요. 폴더 구조(모듈)와 실제 결합이 어긋난 곳을 찾는 데 써요. 정답이 하나인 문제가 아니라서, 예제 저장소(`test/fixtures/cluster_sample`)는 두 덩어리가 뚜렷한 작은 저장소로 잡았어요.

- **그래프**: `Graph.load(store)`의 노드(`allNodes`)와 나가는 간선(`out`)에서 만들어요. 노드는 앱 코드(`role: 'app'`)의 최상위 선언이에요. 멤버(메서드, 필드, 생성자)는 바깥 타입으로 접고, 이름 공간과 테스트 코드, 파일 노드(import 간선)는 빼요. 간선은 방향을 지운 무게 있는 간선이고, 무게는 두 선언 사이의 관계 수(종류 무관)예요. 한 선언 안의 관계(자기 고리)는 셈하지 않아요.
- **알고리즘: Louvain 방법**(모듈성 최대화). V. D. Blondel, J.-L. Guillaume, R. Lambiotte, E. Lefebvre, "Fast unfolding of communities in large networks", *J. Stat. Mech.* (2008) P10008. 라이브러리 없이 직접 구현했어요(들인 부품이 없어 라이선스 걱정이 없어요). 해상도(γ)는 1이에요.
  - 1단계(노드 옮기기)는 노드를 id 순으로 훑고, 모듈성 증가량이 가장 큰 이웃 묶음으로 옮겨요. 같으면 번호가 작은 묶음, 제자리보다 크지 않으면 그대로예요. 2단계는 묶음을 노드 하나로 접어요. 더 옮길 것이 없을 때까지 되풀이해요.
  - 난수를 쓰지 않아서 같은 색인이면 늘 같은 묶음이 나와요.
  - Louvain은 이어지지 않은 묶음을 낼 수 있어요(V. A. Traag, L. Waltman, N. J. van Eck, "From Louvain to Leiden: guaranteeing well-connected communities", *Sci. Rep.* 9, 5233 (2019)). 그래서 마지막에 묶음마다 이어진 조각으로 나눠요. Leiden의 다듬기 단계는 하지 않았어요.
- **답**: `clusters`(`Page`)는 둘 이상이 든 묶음이에요. 큰 것부터, 같으면 대표 이름순. 항목마다 `size`, `representative`(묶음 안 이름과 엮인 무게가 가장 큰 선언, 같으면 id 순: 이름·종류·정의 위치), `names`(이름순), `files`(경로순), `modules`(`moduleResolver(loadRepoConfig(...))`로 구한 모듈, 어느 모듈에도 안 든 파일은 빠짐), `crossModule`(모듈이 둘 이상), `internalEdges`/`externalEdges`(묶음 안/밖과의 관계 수), `confidence`(묶음 안 관계 가운데 가장 낮은 것), `source`. `names`와 `files`는 check의 `cycles.files`처럼 같은 `limit`으로 잘리는 안쪽 목록(`InnerList`)이고, `size`가 이름 수예요.
- `summary`: 셈한 이름 수(`names`), 묶음 수(`clusters`), 혼자 남은 이름 수(`singletons`, 목록에 안 나옴), 여러 모듈에 걸친 묶음 수(`crossModule`), 나눈 결과의 모듈성(`modularity`, 소수 셋째 자리).
- 모듈 기준은 check와 같은 저장소 설정이에요(`--config`, MCP `config`).

## 그래프 탐색

`src/graph/traverse.ts`. impact, trace, clusters가 함께 써요. 질의마다 탐색을 따로 만들지 않아요.

- `GraphStore.edges({ kinds? })`: 관계 하나가 간선 하나(`EdgeRow`). 출발은 사용처를 감싸는 심볼(파일 최상위면 그 파일), 도착은 저장소 안의 심볼 또는 파일(import). 저장소 밖 심볼을 가리키는 관계는 빠져요.
- `Graph.load(store, { kinds? })`: 간선과 정의를 메모리의 인접 목록으로 올려요. 노드 id는 심볼 `s:<열쇠>`, 파일 `f:<경로>`(`nodeId`).
- `graph.in(id)` / `graph.out(id)`: 이 노드를 쓰는 간선 / 이 노드가 쓰는 간선. `graph.node(id)`는 이름, 정의 파일, 역할(app/test), 정의(`DefinitionRow`)를 줘요. `graph.fileNodes(path)`는 파일과 그 파일이 정의한 심볼의 노드예요.
- `graph.reach(starts, 'in' | 'out', maxDepth)`: 너비 우선으로 거리별 도착점(`Reached`)을 줘요. 같은 거리라면 정밀한 길을 먼저 골라요. 길에 추정 관계가 하나라도 있으면 그 도착점은 `inferred`예요. 결과 순서는 거리, 그 안에서 id 순이라 다시 돌려도 같아요.
- `graph.members(id)`: 그 노드와 그 안에 정의된 심볼(멤버, 멤버의 멤버 …). 이름 하나를 출발점·도착점으로 삼을 때 써요(trace).
- `graph.paths(starts, targets, { maxDepth, cap })`: 출발점들에서 도착점들까지 out 방향의 단순 경로(같은 노드를 두 번 지나지 않음)를 길이 순으로 찾아요. 같은 길이면 지나는 노드 id의 사전 순이에요(길이별로 깊이 우선을 id 순으로 돌아 찾는 순서가 곧 답의 순서라 다시 돌려도 같아요). 경로는 도착점에 처음 닿는 곳에서 끝나고 중간에 다른 출발점을 지나지 않아요. 두 노드 사이 간선이 여럿이면 대표 하나(정밀한 관계, 종류가 정밀한 관계, 적힌 자리 순)만 써요. 도착점까지 남은 거리(`reach(targets, 'in')`)로 가지를 치고, `cap`개를 찾으면 멈춰 `capped: true`를 줘요.
- 사용처 수는 `GraphStore.useCounts()`(심볼 열쇠 → 수). "많이 쓰이는 이름"(impact, 기준은 "질의: impact")과 검색 정렬(search)이 이 수를 써요.
- 모듈은 `src/modules.ts`의 `moduleResolver(loadRepoConfig(...))`로 노드의 `path`에서 얻어요.

## 질의: trace

`src/query/trace.ts`. 두 지점 사이 경로(`trace <from> --to <to>`). "이 버튼이 어떻게 저 함수까지 가나"에 답해요.

- 지점: 물은 글이 색인된 파일 경로면 그 파일 노드와 그 파일이 정의한 심볼 전부(`fileNodes`), 아니면 context와 같은 이름 찾기(`findSymbols`)로 심볼 하나와 그 멤버 전부(`members`)예요. 클래스를 주면 그 메서드 안의 호출에서 출발하고, 클래스를 도착점으로 주면 그 멤버에 닿아도 도착이에요. 도착점에 든 노드는 출발점에서 빼요(둘이 같으면 오류).
- 중간에 클래스에 닿아도 그 멤버로 들어가지 않아요. 만들기만 해서 메서드가 불린다고 보지 않아요(Flutter의 `build`처럼 프레임워크가 부르는 길은 아직 안 나와요).
- `follow`: `calls`(기본)는 `Graph.load(store, { kinds: ['call'] })`, `all`은 모든 종류(참조, 읽기, 쓰기, 상속, 구현, import)로 그래프를 올려요.
- `depth`(기본 10): 경로의 가장 긴 길이(구간 수). `limit`: 경로를 앞에서부터 몇 개 줄지. 경로는 `graph.paths`로 찾고 상한 `PATH_CAP`(1000)에서 세기를 멈춰요. 멈췄으면 `paths.capped: true`이고 `total`은 그때까지 센 수(실제는 더 많음)예요.
- 순서: 짧은 것부터, 같은 길이면 지나는 노드 id 순(파일 `f:`가 심볼 `s:`보다 앞). 같은 질문은 늘 같은 답이에요.
- 답: `query`(`from`, `to`), `follow`, `depth`, `status`, `from`·`to`(지점: `name`, `kind`, `path`, 심볼이면 `line`, `column`, `key`), `paths`(`Page` + `capped`).
  - 경로 하나: `length`, `nodes`(지나는 지점), `steps`(구간: `from`, `to`, `kind`, `at` 적힌 자리, `confidence`, `kindConfidence`, `source`), 그리고 경로 전체의 `confidence`·`kindConfidence`·`source`.
- 상태: `found`, `no_path`(`paths`는 빈 목록, `reverse`: to에서 from으로는 이어지는지, `shortestBeyondDepth`: depth 밖에 경로가 있으면 그 가장 짧은 길이), `ambiguous`(`candidates.from`/`candidates.to`: 여럿에 맞은 쪽만), `not_found`(`notFound`: `['from']`, `['to']` 또는 둘 다). 찾지 못한 쪽이 있으면 모호한 쪽보다 먼저 알려요.

### 추정 관계의 표시

구간마다 두 믿음이 따로 붙어요. 경로의 `confidence`·`kindConfidence`는 구간 가운데 가장 낮은 것이라, 경로 하나만 보고도 추정을 거쳤는지 알아요.

- `confidence`: 그 관계가 있다는 것(어디서 무엇을 쓰는지)의 믿음. 정밀 어댑터(scip-dart)의 관계는 `precise`, 추정 어댑터(Tree-sitter, 뒤 티켓)의 관계는 `inferred`예요. `inferred` 구간은 이름으로 이은 것이라 다른 같은 이름일 수 있어요.
- `kindConfidence`: 그 관계의 종류(`kind`)의 믿음. Dart에서 `call`·`read`·`write`·`reference`는 문법으로 가려 `inferred`, `import`와 상속·구현은 `precise`예요. 그래서 Dart의 `follow: calls` 경로는 늘 `kindConfidence: inferred`예요: 관계는 정밀하지만, 그것이 "호출"이라는 것은 문법으로 가린 추정이에요(예: 함수를 값으로 넘기는 곳은 `read`로 가려져 호출 경로에서 빠져요).

## 질의 실행기와 바깥 껍데기

```
src/cli.ts ─┐                                  ┌─▶ src/locate.ts   (저장소 → 색인 파일, 없으면 색인 명령 안내)
            ├─▶ src/queries.ts  askQuery(def) ─┼─▶ QueryDef.run   (src/query/*.ts, 몸통만)
src/mcp.ts ─┘   QUERIES, checkArgs             └─▶ src/answer.ts   (봉투 index, page(), formatAnswer)
```

- `src/queries.ts`: 질의 목록 `QUERIES`와 실행기 `askQuery(def, rawArgs, { repo, db? })`. 인자를 `def.params`대로 검사하고(`checkArgs`), 색인을 열고(`openIndex`), `def.run`의 몸통에 봉투를 씌워요(`envelope`).
- `src/answer.ts`: 답의 계약을 지키는 도우미. `IndexInfo`(봉투), `Page`/`page()`(잘린 목록), `Sourced`(항목의 `confidence`·`source`), `DEFAULT_LIMIT`, `formatAnswer`.
- `src/locate.ts`: `defaultDb(repo)`(저장소마다 `~/.code-atlas/` 아래 파일 하나), `openIndex(target)`, 바깥에 그대로 보일 오류 `UserError`.
- `src/cli.ts`: `index`, `mcp`, 그리고 `QUERIES`의 질의마다 명령 하나. `Param`의 `positional`은 위치 인자, 나머지는 `--이름` 옵션이에요.
- `src/mcp.ts`: 공식 MCP SDK(`McpServer`, stdio). `QUERIES`의 질의마다 도구 하나, 입력 스키마는 `Param`에서 만든 zod에 `repo`를 더한 것. 오류는 `isError` 결과로 돌려줘요.

## 언어 적합성 묶음

`test/conformance/questions.ts`(질문)와 `test/conformance.test.ts`(돌리는 틀). 질문은 언어와 무관하고, 언어마다 같은 모양의 예제 저장소(이름이 같은 함수·상수·변수·provider·타입, barrel, 빼야 할 파일)에 던져 그 언어의 정답(`test/expected/<예제>/conformance/<질문>.json`)과 비교해요. 파일 경로처럼 언어마다 다른 값은 `conformance/fixture.json`의 자리표시자(`{pricingFile}` 등)로 채워요. 예제가 갖출 모양은 `questions.ts` 머리에 적혀 있어요.

질문에는 GitNexus 1.6.12가 hijo_app에서 놓친 경우(최상위 변수·provider의 사용처, barrel을 거친 사용처, 같은 이름 메서드)가 들어 있어요. 정답에는 항목마다 `confidence`와 `kindConfidence`가 적혀 있어서, 그 언어가 무엇을 정밀하게 내고 무엇을 추정으로 내는지가 정답 파일에 기록돼요.
