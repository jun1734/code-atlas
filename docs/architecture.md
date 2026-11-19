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
  files: { path: string; language: string }[];
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
  confidence: 'precise' | 'inferred';
  source: string;         // 낸 색인기
}

interface RelationFact {
  kind: 'import' | 'reference' | 'read' | 'write' | 'call' | 'extends' | 'implements';
  from: { path: string; range: Range; symbolKey?: string }; // 적힌 자리와 감싸는 심볼
  to: { symbolKey: string } | { path: string };             // 심볼 또는 파일(import)
  confidence: 'precise' | 'inferred';
  source: string;
}
```

SCIP에서 옮기는 규칙(`src/scip/to-facts.ts`):

- 정의: `Definition` 역할이 붙은 occurrence. 종류는 `SymbolInformation.kind`, 없으면 심볼 문자열 꼬리(`().` 함수, `#` 타입, `.` 값)로 짐작해요.
- 사용처: 그 밖의 occurrence. 같은 파일에서 `enclosingRange`가 사용처를 품는 정의 중 가장 안쪽 것을 `from.symbolKey`로 둬요.
- 관계 종류: SCIP 역할의 `Import`/`WriteAccess`/`ReadAccess`를 따르고, 아무것도 없으면 `reference`예요. scip-dart 1.8.1은 읽기/쓰기를 가려 주지 않아서 Dart 사용처는 지금 모두 `reference`예요.
- 파일 자체를 가리키는 심볼(`` …/`lib/a.dart`/ ``)에 대한 occurrence(import/export 지시문)는 파일→파일 `import` 관계가 돼요.
- `local N` 심볼(지역 변수)은 넣지 않아요.

## 그래프 스키마

정의: `src/graph/store.ts`. SQLite 파일 하나, 저장소 밖에 둬요.

| 표 | 열 | 뜻 |
| --- | --- | --- |
| `meta` | `key`, `value` | `schema`(스키마 버전), `repoRoot`, `commit`(색인 기준 커밋), `indexedAt` |
| `files` | `id`, `path`, `language` | 파일 노드 |
| `symbols` | `id`, `key`, `name`, `qualified_name`, `kind`, `file_id`, `line`, `col`, `end_line`, `end_col`, `parent_key`, `confidence`, `source` | 심볼 노드와 정의 위치(0부터) |
| `relations` | `id`, `kind`, `from_file_id`, `from_symbol_key`, `line`, `col`, `end_line`, `end_col`, `to_symbol_key`, `to_file_id`, `confidence`, `source` | 간선. 대상은 `to_symbol_key`(심볼) 또는 `to_file_id`(import) |

- 모든 간선과 심볼에 신뢰도(`precise`/`inferred`)와 출처(색인기)가 있어요.
- `to_symbol_key`는 저장소 밖 심볼(예: `dart:core`의 `print`)도 가리킬 수 있어요. 그런 심볼은 `symbols`에 없어요.
- 색인할 때마다 전체를 한 트랜잭션으로 바꿔요. 바뀐 파일만 반영하는 증분 색인은 뒤 티켓에서 해요.
- 바깥에 보이는 것은 열고 닫기(`open`, `openExisting`, `close`), 넣기(`replaceAll(facts, meta)`), 질의 함수(`findSymbols`, `usesOf`, `meta`, `counts`)뿐이에요. 스키마를 바꿔도 질의 함수의 답이 같으면 테스트는 그대로 통과해요.

## 질의: context

`src/query/context.ts`. 이름을 `key` → `qualifiedName` → `name` 순으로 찾고, 처음 맞는 단계의 결과를 써요. 파일과 매개변수(`kind`가 `file`, `parameter`)는 찾지 않아요.

답의 봉투(`index`: 저장소, 기준 커밋, 낡음)는 실행기가 씌워요. 계약은 [contract.md](contract.md)에 있어요.

- 하나: `status: 'found'`, 정의와 사용처(앞에서부터 `limit`개, `total`, `truncated`).
- 여럿: `status: 'ambiguous'`, `candidates`. 하나를 골라 그 `qualifiedName`이나 `key`로 다시 물어요.
- 없음: `status: 'not_found'`.

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
