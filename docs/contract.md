# 답의 계약

모든 도구(context, impact, check, trace, search, clusters …)의 답이 지키는 약속이에요. 명령줄과 MCP 서버는 같은 답을 내요.
지키는 곳은 `src/answer.ts`(봉투, 목록, 항목)와 `src/queries.ts`(실행기) 한곳이고, 시험은 `test/contract.test.ts`가 도구 호출 경계에서 해요.

## 답의 모양

답은 JSON 객체 하나예요. 맨 앞은 봉투 `index`, 그 뒤는 질의마다 다른 몸통이에요.

```json
{
  "index": {
    "repo": "/abs/path/to/repo",
    "commit": "9f1c…",
    "indexedAt": "2026-11-19T10:00:00.000Z",
    "stale": false
  },
  "query": "withTax",
  "status": "found",
  "symbol": { "name": "withTax", "kind": "function", "definition": { "path": "lib/src/pricing.dart", "line": 2, "column": 5 }, "confidence": "precise", "source": "scip-dart" },
  "uses": { "total": 3, "truncated": false, "items": [ { "path": "bin/checkout.dart", "line": 5, "column": 9, "kind": "reference", "confidence": "precise", "source": "scip-dart" } ] }
}
```

## 약속

1. **봉투: 모든 답에 `index`가 있어요.**
   - `repo`: 색인한 저장소의 절대 경로. 여러 저장소 중 어느 것의 답인지 알 수 있어요.
   - `commit`: 색인 기준 커밋. git 저장소가 아니면 `null`.
   - `indexedAt`: 색인한 때(ISO 8601).
   - `stale`: 색인 뒤로 바뀐 것이 있는지. HEAD가 `commit`과 다르거나 작업 트리가 색인할 때와 달라졌으면(`git status --porcelain`에 나오는 파일과 그 내용으로 비교) `true`, 그대로면 `false`, 알 수 없으면(git 저장소가 아님) `null`. `true`면 답을 그대로 믿지 말고 다시 색인해요.
   - 봉투는 실행기(`askQuery`)가 씌워요. 질의는 몸통만 만들고, 몸통에 `index`를 넣을 수 없어요(`Body` 타입이 막아요).
2. **목록: 길어질 수 있는 목록은 `{ total, truncated, items }`예요.**
   - `items`는 앞에서부터 `limit`개, `total`은 자르기 전 전체 개수, `truncated`는 `items`가 전체보다 적은지.
   - 질의는 `cut(all, limit)`(전체를 앞에서부터 자름)이나 `page(items, total)`(이미 자른 것)로 만들어요. `limit` 인자의 기본은 `DEFAULT_LIMIT`(100), 가장 작은 값은 1이에요.
   - 순서는 질의마다 정하되 늘 같아야 해요(같은 색인, 같은 질문이면 같은 답). context의 사용처는 앱 코드가 먼저, 테스트가 뒤이고, 그 안에서 경로, 줄, 열 순이에요. 파일 답의 목록(`defines`, `imports`, `importedBy`, `usedBy`)도 `Page`예요.
   - 항목 안의 목록(check `cycles`의 `files`·`imports`, clusters 묶음의 `names`·`files`)도 같은 모양(`InnerList`)이고 같은 `limit`으로 잘려요. 항목이 글(경로, 이름)이라 정밀/추정과 출처는 그 목록을 가진 바깥 항목의 것이에요. 모듈 이름 목록(`modules`)은 모듈 수만큼이라 자르지 않아요.
3. **항목: 답의 항목마다 `confidence`와 `source`가 있어요.**
   - `confidence`: `precise`(컴파일러 수준 색인기) 또는 `inferred`(이름으로 이은 추정). `inferred`면 직접 확인해요.
   - `source`: 그 항목을 낸 색인기(예: `scip-dart`).
   - `Page<T>`의 `T`는 `Sourced`(이 두 칸)를 가져야 해서 타입이 빠뜨림을 막아요.
4. **모호하면 고르지 않아요.** 이름이 여럿에 맞으면 `status: "ambiguous"`와 후보 목록을 돌려줘요. 하나를 골라 그 `qualifiedName`이나 `key`로 다시 물어요.
5. **저장소를 골라 물어요.** 저장소마다 따로 색인해요(색인 파일은 `~/.code-atlas/<저장소이름>-<경로해시>.db`, `CODE_ATLAS_HOME`으로 폴더를 바꿔요). 명령줄은 `--repo`(또는 `--db`), MCP는 도구 인자 `repo`로 골라요. MCP에서 `repo`가 없으면 서버를 띄운 저장소(`code-atlas mcp --repo`, 없으면 서버의 작업 폴더)예요.
6. **오류는 답이 아니에요.** 색인이 없거나, 인자가 틀렸거나, 색인의 스키마 버전이 다르면 답 대신 고칠 방법을 담은 메시지를 내요.
   - 색인이 없으면: 찾은 자리와, 그대로 붙여 돌릴 색인 명령(`node "<…>/src/cli.ts" index "<저장소>"`)을 알려 줘요.
   - 명령줄: stderr에 메시지, 종료 코드 1(명령이 없거나 모르는 명령이면 사용법과 함께 2), stdout은 비어요.
   - MCP: `isError: true`인 도구 결과, 글에 메시지.
7. **네트워크를 쓰지 않아요.** 색인과 질문은 내 컴퓨터에서만 돌아요. MCP 서버는 stdio로만 말하고 포트를 열지 않아요. 테스트는 모든 도구 프로세스에 네트워크 차단 장치(`test/no-network.ts`)를 달아, 연결을 시도하면 그 테스트가 실패해요.
8. **명령줄과 MCP의 답은 같아요.** 둘 다 같은 `askQuery`를 부르고 같은 `formatAnswer`(들여쓴 JSON)로 내요. MCP는 그 글을 `text` 내용 하나로 돌려줘요.

### 아직 계약 밖인 것

- trace의 경로 목록(`paths`)은 상한(1000개)에서 세기를 멈춰요. 그때는 `paths.capped: true`이고 `total`은 자르기 전 전체가 아니라 센 데까지예요(실제는 더 많아요). 경로 수는 길이에 따라 폭발할 수 있어서 다 세지 않아요.
- context의 후보 목록(`candidates`)은 잘리지 않는 맨 배열이에요. 이름 하나에 맞는 후보는 몇 개뿐이라 그대로 뒀어요. 후보가 많아질 수 있는 질의(search 등)는 `Page`로 내요.

## 질의 붙이는 법

명령줄과 MCP는 `src/queries.ts`의 `QUERIES` 목록을 똑같이 감싸요. 새 질의 하나는 이렇게 붙어요.

1. `src/query/<이름>.ts`에 몸통을 만드는 함수와 `QueryDef`를 만들어요.

   ```ts
   import { DEFAULT_LIMIT, page, type Page } from '../answer.ts';
   import type { GraphStore } from '../graph/store.ts';
   import type { QueryDef } from '../queries.ts';

   export const impactQuery: QueryDef = {
     name: 'impact',                       // 명령줄 명령 이름이자 MCP 도구 이름
     description: '…에이전트가 언제 부를지 알 수 있게…',
     params: [
       { name: 'target', type: 'string', positional: true, required: true, description: '…' },
       { name: 'depth', type: 'integer', min: 1, default: 3, description: '…' },
       { name: 'limit', type: 'integer', min: 1, default: DEFAULT_LIMIT, description: '…' },
     ],
     run: (store, args) => impact(store, args.target as string, args.depth as number, args.limit as number),
   };
   ```

   - `run`은 몸통만 돌려줘요(`index`는 넣지 않아요). 목록은 `page(items, total)`로, 항목에는 `confidence`와 `source`를 붙여요.
   - `params`는 명령줄 옵션(`--depth 3`, 위치 인자 하나)과 MCP 입력 스키마(zod)가 둘 다 여기서 만들어져요. 인자 검사(필수, 정수, 가장 작은 값)는 `checkArgs`가 해요. 타입은 지금 `string`과 `integer`뿐이고, 더 필요하면 `Param.type`과 `checkArgs`, `src/mcp.ts`의 `schemaOf`, 이 문서를 같이 고쳐요.
   - `repo`, `db`는 실행기가 따로 받아요. `params`에 넣지 않아요.
   - 이름 있는 인자는 질의끼리 이름이 같아도 돼요(명령줄은 모든 질의의 옵션을 글로 받아요).
2. `src/queries.ts`의 `QUERIES`에 한 줄 더해요: `export const QUERIES: QueryDef[] = [contextQuery, impactQuery];`
3. 테스트는 도구 호출 경계에서: 예제 저장소를 색인하고 명령줄(`fx.ask('impact', …)`)과 MCP(`startMcp()` → `call('impact', {…})`)로 물어 `test/expected/`의 정답과 비교해요. 봉투·잘림·정밀/추정은 이 계약의 테스트가 이미 보니, 새 질의 테스트는 답의 내용을 봐요. 다만 새 질의도 `index`와 `Page` 모양을 지키는지 한 번은 확인해요.

명령줄과 MCP 쪽 코드는 고치지 않아요. 붙인 뒤 `code-atlas --help`의 사용법과 MCP 도구 목록에 저절로 나와요.
