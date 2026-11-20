# code-atlas

여러 언어의 코드를 이름(심볼) 단위로 색인해, 언어와 무관한 그래프 하나에 쌓고 질문을 던지는 도구예요.
"이 이름은 어디서 정의되고 어디서 쓰이나"를 문자열 검색이 아니라 컴파일러 수준 색인으로 답해요.

지금 되는 것: Dart 저장소 색인(정밀: scip-dart, 추정: Tree-sitter), `context`, `check`, `impact`, `detect_changes`, `search`, `trace`, `clusters`, `flows`(명령줄과 MCP 서버), 코드 지도 HTML(`map`, 명령줄). 앞으로 붙을 것(Python·JS/TS 등)은 [jun1734/hijo#204](https://github.com/jun1734/hijo/issues/204)에 있어요.

## 준비

| 부품 | 버전 | 설치 |
| --- | --- | --- |
| Node.js | 24 이상 (`.ts`를 그대로 돌리고 내장 `node:sqlite`를 써요) | <https://nodejs.org> |
| Dart SDK | 3.5 이상 (Flutter SDK에 든 것도 돼요) | <https://dart.dev/get-dart> |
| scip-dart | 1.8.1 | `dart pub global activate scip_dart 1.8.1` |

정밀 색인기(scip-dart)가 없거나 실패해도 색인은 끝나요. 무엇을 어떻게 설치하는지 stderr에 안내하고(색인 요약의 `fallbacks`에도 남아요), 그 언어는 추정 층(Tree-sitter)으로 색인해요. 추정 층의 답은 모두 `confidence: inferred`예요. 추정 층은 npm 패키지(WASM)라 따로 설치할 것이 없어요.

```sh
npm ci
```

## 돌리는 법

```sh
# 색인: 저장소의 Dart 패키지(추적되는 pubspec.yaml마다)를 scip-dart로 색인해요.
# 패키지마다 pub get이 먼저 돼 있어야 해요(.dart_tool/package_config.json). 없으면 그 언어는 추정 층으로 색인해요.
# 패키지 밖의 Dart 파일(예: 패키지 없는 스크립트)은 추정 층이 색인해요. 정밀 색인이 있는 파일은 추정 층이 덮어쓰지 않아요.
# 정밀 색인기를 없는 것으로 치려면(추정 층만 쓰기): CODE_ATLAS_DISABLE_INDEXERS=scip-dart
node src/cli.ts index path/to/repo

# 질문: 이름 하나의 정의 위치, 종류, 사용처
node src/cli.ts context withTax --repo path/to/repo
node src/cli.ts context Cart.add --repo path/to/repo   # 같은 이름이 여럿이면 바깥 타입을 붙여요
node src/cli.ts context withTax --repo path/to/repo --limit 20
node src/cli.ts context lib/src/cart.dart --repo path/to/repo  # 파일: 정의하는 이름, 가져다 쓰는 파일, 쓰이는 파일

# 구조 검사: 서로 물린 파일 묶음, 모듈 사이에서 흐름을 거스르는 import(최소 개수, 허용 목록/새 위반)와 층,
# 다른 기능 모듈에서 가져다 쓰는 리뷰 후보, 어디서도 쓰이지 않는 공개 이름
node src/cli.ts check --repo path/to/repo
node src/cli.ts check --repo path/to/repo --config path/to/code-atlas.json

# 영향 범위: 이름이나 파일을 바꾸면 영향 받는 곳(거리별, 모듈별 묶음, 걸린 테스트 파일)
node src/cli.ts impact withTax --repo path/to/repo
node src/cli.ts impact lib/src/cart.dart --repo path/to/repo --depth 2 --limit 50
node src/cli.ts impact withTax --repo path/to/repo --hot 50   # 사용처가 50개 이상인 이름에 hot 표시(기본 20)

# 변경 영향: 작업 트리의 diff(새 파일 포함)가 건드린 이름(added/removed/modified/moved)과 그 영향 범위, 닿는 모듈과 테스트,
# 이 변경으로 새로 생긴 순환과 경계 위반(이미 있던 것과 구분). 색인이 낡았으면 먼저 다시 색인해요.
node src/cli.ts detect_changes --repo path/to/repo
node src/cli.ts detect_changes --base main --head feat/x --repo path/to/repo           # 두 커밋(브랜치) 사이
node src/cli.ts detect_changes --base $(git merge-base main HEAD) --repo path/to/repo # PR: 갈라진 지점부터 작업 트리까지

# 검색: 정확한 이름을 몰라도 시작점 찾기(이름 일부, 대소문자 무시, 낙타 표기 조각). 많이 쓰이는 것이 먼저.
# 결과의 key를 그대로 context에 넘겨요.
node src/cli.ts search cartProv --repo path/to/repo
node src/cli.ts search total --kind function,method --language dart --folder lib/src --repo path/to/repo

# 묶음: 서로 촘촘히 엮인 이름들(Louvain). 묶음마다 이름, 파일, 대표 이름, 여러 모듈에 걸쳤는지(crossModule)
node src/cli.ts clusters --repo path/to/repo

# 실행 흐름: 진입점(불리지 않는 이름, 설정의 flows.entries)에서 호출을 따라 거치는 이름들
node src/cli.ts flows --repo path/to/repo
node src/cli.ts flows --depth 5 --length 10 --limit 20 --repo path/to/repo  # 깊이, 흐름마다 이름 수, 흐름 수
node src/cli.ts flows petMotionOffProvider --repo path/to/repo             # 이 이름이 든 묶음과 이 이름을 거치는 흐름

# 두 지점 사이 경로: from이 어떤 호출을 거쳐 to까지 가나(가장 짧은 것부터, --limit개까지)
node src/cli.ts trace OrderButton --to writeRow --repo path/to/repo
node src/cli.ts trace lib/ui/a.dart --to lib/data/db.dart --follow all --repo path/to/repo  # 참조·import도 따라가요
node src/cli.ts trace OrderButton --to logAudit --depth 15 --repo path/to/repo             # 더 긴 경로까지(기본 10)
```

trace의 답과 표시(구간마다 `confidence`와 `kindConfidence`)는 [docs/architecture.md](docs/architecture.md#질의-trace)에 있어요.

check와 impact의 모듈 기준(어느 폴더가 모듈인지, 공용·조립 모듈, 허용 목록 위치)은 저장소 뿌리의 `.code-atlas.json`에 적어요. 형식은 [docs/architecture.md](docs/architecture.md#저장소-설정과-모듈)에 있어요. 없으면 뿌리 바로 아래 폴더 하나가 모듈 하나예요.

- 답은 JSON이에요. `status`는 `found`, `ambiguous`(후보 목록 `candidates`), `not_found` 중 하나예요.
- 사용처는 앱 코드가 먼저, 테스트가 뒤에 와요. 항목마다 `role`(`app`/`test`), `kind`(`read`, `write`, `call`, `extends`, `implements`, `reference`), `kindConfidence`가 붙고, `uses.byRole`에 역할별 전체 개수가 있어요.
- `kindConfidence`: Dart의 읽기·쓰기·호출은 scip-dart 1.8.1이 가려 주지 않아서 소스 문법으로 가린 추정(`inferred`)이에요. 상속·구현은 scip-dart가 준 타입 관계로 확인해 `precise`예요. 사용처가 있다는 것 자체(`confidence`)는 정밀이에요. 자세한 규칙은 [docs/architecture.md](docs/architecture.md)의 "Dart 어댑터가 더 하는 일".
- 생성된 코드(`*.g.dart` 등, `GENERATED CODE` 머리), 빌드 산출물(`build/`, `.dart_tool/`), git이 무시하는 파일은 색인에서 빠져요.
- 모든 답은 [답의 계약](docs/contract.md)을 따라요: 색인한 저장소와 기준 커밋(`index.repo`, `index.commit`), 낡았는지(`index.stale`: 색인 뒤 커밋이 바뀌었거나 작업 트리가 색인할 때와 달라졌으면 `true`, git 저장소가 아니면 `null`), 목록의 전체 개수(`total`)와 잘렸는지(`truncated`), 항목마다 `confidence`(`precise` 정밀 / `inferred` 추정)와 `source`(어느 색인기).
- 줄과 열은 1부터 세요.

### 코드 지도 (HTML 한 장)

```sh
node src/cli.ts map --repo path/to/repo                       # 색인 파일 옆 <이름>-map.html에 그려요
node src/cli.ts map --repo path/to/repo --out build/map.html  # 나올 파일을 정해요
```

모듈 지도(층과 흐름을 거스르는 import), 흐름을 거스르는 import(허용 목록 표시), 서로 물린 파일, 다른 기능 폴더에서 가져다 쓰는 것(리뷰 후보), 외부 SDK가 닿는 파일, 파일 찾아보기(줄 수, 최근 90일 변경 횟수, 쓰이는 곳, 테스트)를 한 장에 모아요. 머리말에 브랜치와 커밋이 적혀요. 브라우저로 열어요.

- 명령 한 번이면 돼요: 색인이 없거나 낡았으면(`index.stale`) 먼저 색인하고 그려요. 출력은 나온 파일(`out`), 그 전에 색인했는지(`indexed`), 브랜치·커밋과 개수를 담은 JSON이에요.
- 구조 계산은 `check`의 답을 그대로 써요. 모듈 기준과 화면 설정(제목, 띠로 그릴 모듈, 외부 SDK 목록, 리뷰 후보 메모)은 `.code-atlas.json`(`--config`)이에요. 형식은 [docs/architecture.md](docs/architecture.md#코드-지도-map)에 있어요.
- 파일 줄마다 `#file=<경로>`로 가리킬 수 있어요(예: `…-map.html#file=lib/src/cart.dart`). 그 파일 하나만 남기고 줄로 데려가요.
- 나온 파일만 쓰고 저장소는 바꾸지 않아요(`--out`으로 저장소 안을 고르면 거기 써요). 화면은 글꼴을 Google Fonts에서 받아요(없으면 시스템 글꼴). 코드는 밖으로 나가지 않아요.

### 다시 색인하기와 색인 요약

코드를 고친 뒤 같은 `index` 명령을 다시 돌려요. 색인기(scip-dart)는 저장소 전체를 다시 돌리지만, 그래프에는 사실이 달라진 파일만 반영해요(증분 반영). 고친 채로(커밋하지 않고) 색인해도 돼요. 그 뒤로 또 고치지 않았으면 답의 `index.stale`은 `false`예요.

`index`는 요약을 JSON으로 내요. 파일 수(`files`), 이름 수(`symbols`), 관계 수(`relations`), 언어별 개수와 관계의 정밀/추정 비율(`languages.<언어>.precise`, `.inferred`), 이번에 반영한 파일 수(`changes`: `added`, `modified`, `removed`, `unchanged`), 걸린 시간(`ms`: 색인기 실행 `indexers`, 그래프 반영 `graph`, 전체 `total`)이 들어가요. 칸의 뜻은 [docs/architecture.md](docs/architecture.md#색인-요약-index-명령의-출력)에 있어요.

색인 파일은 저장소 밖 `~/.code-atlas/<저장소이름>-<경로해시>.db`에 둬요. `--db`로 자리를 정하거나 `CODE_ATLAS_HOME`으로 폴더를 바꿔요.
여러 저장소를 각각 색인해 두고 `--repo`로 골라 물어요. 색인이 없는 저장소를 물으면 색인하는 명령을 알려 줘요.

### MCP 서버

```sh
node src/cli.ts mcp [--repo 기본저장소=.]
```

공식 MCP SDK로 stdio 서버를 열어요(포트를 열지 않고, 네트워크를 쓰지 않아요). 명령줄의 질의(`context` …)가 같은 이름의 도구로 나오고, 답은 명령줄과 같은 JSON 글이에요.
도구마다 `repo` 인자로 물을 저장소를 골라요. 없으면 서버를 띄운 저장소(`--repo`, 없으면 서버의 작업 폴더)예요.

**Claude Code에 붙이기** (Claude Code는 서버를 프로젝트 폴더에서 띄우니, 그 프로젝트가 기본 저장소가 돼요):

```sh
# 1. 물을 저장소를 먼저 색인해요(저장소마다 한 번, 코드가 바뀌면 다시).
node C:/hijo/code-atlas/src/cli.ts index C:/hijo/hijo_app

# 2. 서버를 등록해요. --scope user면 모든 프로젝트에서, 빼면 지금 프로젝트에서만 써요.
claude mcp add --scope user code-atlas -- node C:/hijo/code-atlas/src/cli.ts mcp

# 3. 확인: Claude Code 안에서 /mcp, 또는
claude mcp list
```

경로는 이 저장소를 받은 자리로 바꿔요. 프로젝트 하나에 고정하려면 그 저장소의 `.mcp.json`에 적어도 돼요.

```json
{
  "mcpServers": {
    "code-atlas": { "command": "node", "args": ["C:/hijo/code-atlas/src/cli.ts", "mcp"] }
  }
}
```

### 색인은 저장소를 바꾸지 않아요

- scip-dart 산출물(`index.scip`)은 OS 임시 폴더에 쓰고 지워요.
- `pub get`을 대신 돌리지 않아요(네트워크를 쓰고 생성 파일을 만들어서요). `.dart_tool/package_config.json`이 없으면 할 일(`dart pub get` 또는 `flutter pub get`)을 알려 주고 멈춰요.
- 숨김 폴더(`.`으로 시작)와 `build` 폴더 안의 `pubspec.yaml`은 패키지로 보지 않아요.
- detect_changes는 작업 트리를 git 색인의 임시 사본에 담아 비교해요(staging은 그대로, 새 파일의 blob이 `.git/objects`에 남을 수 있어요). base 커밋은 임시 폴더의 로컬 복제(`git clone --shared`)에서 한 번 색인해 저장소 색인 옆(`…@<커밋>.db`)에 두고 다시 써요. 처음 한 번은 저장소 색인만큼 걸려요.
- 색인 범위: scip-dart 1.8.1은 패키지 안의 Dart 파일을 모두 색인해요(`lib`, `bin`, `test` 등). #204는 "기본은 `lib`만, 테스트는 옵션"이라고 적었지만, 그건 scip-dart의 동작을 잘못 안 것이었어요. 테스트 사용처는 파일의 역할(`test/`, `integration_test/`, `test_driver/`, `*_test.dart`)로 나눠요.

### 측정 (2026-11-19, Windows 11 노트북)

hijo_app(Flutter, Dart 파일 329개, `lib`·`test` 포함): DB 28MB, 심볼 5,790개, 관계 72,456개, 관계는 모두 정밀.

색인기 실행과 그래프 반영을 따로 쟀어요(#218). hijo_app의 커밋 사본(`git archive`에 `.dart_tool/package_config.json`을 더한 것)을 색인했어요.

| 경우 | 반영한 파일 | 색인기(scip-dart) | 그래프 반영 |
| --- | --- | --- | --- |
| 처음 색인 | 329개 더함 | 84.4초 | 0.95초 |
| 아무것도 안 바꾸고 다시 | 0개 | 54.5초 | 0.10초 |
| `lib` 파일 하나에 함수 하나 더하고 다시 | 1개 바꿈 | 28.0초 | 0.13초 |

- 색인기 시간이 28~84초로 크게 흔들린 건 같은 노트북에서 다른 작업(다른 에이전트의 테스트)이 함께 돌았기 때문이에요. 흔들림을 빼도 결론은 같아요.
- 다시 색인할 때 시간의 99% 넘게가 색인기 실행이에요. 그래프 반영은 증분으로 0.1초 남짓이라 더 줄일 게 없어요.
- **판단: 색인기 실행을 줄일 값어치가 있어요.** 작업 중에 금방 최신이 되려면 이 30~80초를 줄여야 해요. 다만 scip-dart 1.8.1은 파일 하나만 색인하는 방법이 없고 패키지 단위로 돌아요. 그래서 줄이는 길은 (1) 바뀐 파일이 없는 패키지는 색인기를 건너뛰기(hijo_app처럼 패키지가 하나인 저장소에는 효과가 없어요. 또 다른 패키지가 가리키는 이름이 바뀌면 그 패키지도 다시 돌려야 해요), (2) Dart 분석기를 띄워 둔 채 바뀐 파일만 다시 분석하는 상주 색인기(scip-dart를 고치거나 새로 짜야 해요) 중 하나예요. 어느 쪽으로 갈지는 뒤 티켓에서 정해요.

## 검사

```sh
npm run check      # 타입 검사(tsc --noEmit) + 테스트
```

테스트는 실제 scip-dart를 돌려요(가짜 SCIP 파일을 쓰지 않아요). 그래서 위 준비물이 모두 있어야 해요.
Dart 예제(`test/fixtures/dart_sample`)는 Riverpod provider를 묻는 질문 때문에 `riverpod`(MIT)에 기대요. 그래서 테스트에는 Dart SDK 3.12 이상이 필요하고, 처음 한 번은 테스트 틀의 `dart pub get`이 pub.dev에서 패키지를 받아요(도구 자체는 네트워크를 쓰지 않아요).
언어 적합성 묶음(`test/conformance.test.ts`, 질문은 `test/conformance/questions.ts`)은 같은 질문을 언어마다 같은 모양의 예제 저장소에 던져요. 새 언어는 예제 저장소와 `test/expected/<예제>/conformance/` 정답을 더하고 `RUNS`에 층마다(정밀 `precise`, 추정 `inferred`) 올려요. 추정 층의 통과/놓침은 [docs/architecture.md](docs/architecture.md#추정-층-적합성-dart_sample)의 표에 적고, 테스트가 표와 실제가 맞는지 봐요.
테스트는 `test/fixtures/<예제>`를 임시 git 저장소로 복사해 명령줄로 색인하고, 명령줄과 MCP 서버(공식 SDK 클라이언트로 붙어요)로 질문해 `test/expected/<예제>/`의 정답과 비교해요. 내부 모듈은 시험하지 않아요.
모든 도구 프로세스는 네트워크 차단 장치(`test/no-network.ts`)를 단 채로 돌아서, 네트워크를 쓰려 하면 테스트가 실패해요.

**한계: 차단 장치는 도구가 띄우는 자식 프로세스(scip-dart)를 덮지 못해요.** 장치는 Node의 `--import`라 Node 프로세스 안에서만 돌아요. scip-dart는 Dart 프로세스(`dart pub global run scip_dart`)예요. 프로세스 하나의 네트워크만 막는 일은 OS 기본 기능으로 고르게 할 수 없어서(Linux의 네트워크 이름 공간은 권한이 필요하고, Windows는 방화벽 규칙에 관리자 권한이 필요해요) 다음으로 대신해요.

- 테스트 틀은 모든 도구 프로세스에 닫힌 곳(`127.0.0.1:9`)을 가리키는 `PUB_HOSTED_URL`과 HTTP 프록시(`HTTP_PROXY`, `HTTPS_PROXY`)를 줘요(`test/harness.ts`의 `CHILD_NETWORK_TRAP`). 자식이 pub이나 표준 HTTP 클라이언트로 패키지를 받으려 하면 연결이 거절돼 색인이 실패해요. 날 소켓까지는 막지 못해요.
- scip-dart가 네트워크를 쓰지 않는다는 근거: 색인기는 `pub get`을 대신 돌리지 않고(위 "색인은 저장소를 바꾸지 않아요"), scip-dart는 이미 있는 `.dart_tool/package_config.json`이 가리키는 로컬 패키지 캐시의 소스를 Dart 분석기로 읽기만 해요(패키지를 받는 일은 `pub get`의 몫이에요). `dart pub global run`은 활성화해 둔 패키지를 로컬에서 돌려요. 위 덫을 단 채로 모든 테스트의 색인이 통과해요.

CI(`.github/workflows/ci.yml`)는 Linux(ubuntu)와 Windows 양쪽에서 같은 검사를 돌려요.

hijo_app(커밋 7ba0197)의 check 답과 `map`이 그린 지도가 옛 코드 지도(hijo_app PR #188의 `scripts/code-map/build.mjs`, 지금은 지움)와 같은지는 따로 봐요(Flutter SDK 필요, 2분쯤). 저장소를 임시 폴더로 clone해서 쓰니 원래 저장소는 바뀌지 않아요. 옛 스크립트는 `HIJO_APP_REPO`의 기록(커밋 `47dbba6`)에서 꺼내 같은 사본에 돌려 비교해요. 다른 점 두 가지는 테스트에 이유와 함께 적혀 있어요(`test/hijo_app/hijo_app.verify.ts`): 리뷰 후보에 `test_flow.dart` 하나가 더 나오고, 테스트 열에서 barrel에만 들고 테스트가 이름을 쓰지 않는 파일(`hijo_pairs.dart`)이 "묶음 경유" 대신 "없음"이에요.

```sh
HIJO_APP_REPO=C:/hijo/hijo_app npm run verify:hijo
```

## 플랫폼 메모

- **Windows**: scip-dart 1.8.1은 같은 심볼을 OS마다 다르게 적어요. Linux는 ``lib/src/`a.dart`/add().``(경로 칸마다 기술자 하나), Windows는 `` `lib\src\a.dart`/add(). ``(경로 통째로 기술자 하나, 구분자 `\`)예요. 그대로 두면 같은 심볼의 열쇠가 OS마다 달라져서, Dart 어댑터가 Windows 꼴을 Linux 꼴로 바꿔요. CI의 Linux 잡이 처음에 이 차이를 잡았어요.
- **경로 인자 함정**: scip-dart에 패키지 경로를 `./`로 주면 패키지 전체를 "중첩 패키지"로 보고 파일을 0개 색인해요(오류 없이 빈 색인). 어댑터는 항상 절대 경로를 줘요.
- scip-dart 1.8.1이 색인 메타데이터에 적는 버전은 `1.7.0`이에요(그쪽 버전 상수가 갱신되지 않았어요). 동작과는 상관없어요.

## 라이선스 방침

- **무료 오픈소스 부품만 써요.** 상용 개발에 쓸 수 있는 라이선스(MIT, BSD, Apache-2.0 등)만 들여요. 비상업 전용(PolyForm Noncommercial 등)이나 유료 부품, 네트워크로 코드를 내보내는 서비스는 쓰지 않아요. 새 부품을 들일 때 라이선스를 먼저 확인해요.
- **GitNexus 코드는 복사하지 않아요.** GitNexus는 PolyForm Noncommercial이라 상용 개발에 쓸 수 없어요. 기능 아이디어만 참고해 다시 구현해요.
- 지금 쓰는 부품: scip-dart(Apache-2.0, 별도 설치), web-tree-sitter(MIT, Tree-sitter의 WASM 파서, 추정 층), @repomix/tree-sitter-wasms(Unlicense, 미리 빌드한 문법 WASM. 그 안의 문법은 각자의 라이선스예요: tree-sitter-dart MIT(UserNobody14/tree-sitter-dart), 뒤에 쓸 tree-sitter-python·tree-sitter-javascript·tree-sitter-typescript 모두 MIT. 2026-11-20 확인), riverpod(MIT, 테스트 예제 저장소의 의존성만), protobufjs(BSD-3-Clause), `@modelcontextprotocol/sdk`(MIT, 공식 MCP SDK. 딸린 패키지도 모두 MIT/ISC/BSD/Apache-2.0으로 확인), zod(MIT, MCP 입력 스키마), TypeScript(Apache-2.0, 개발용), @types/node(MIT, 개발용), Node 내장 `node:sqlite`·`node:test`.
- 추정 층은 네이티브 빌드가 필요 없는 WASM 부품만 써요(`tree-sitter` npm 패키지는 node-gyp 빌드가 필요해서 쓰지 않았어요). Windows와 Linux CI에서 같은 파일이 돌아요. 원래의 `tree-sitter-wasms`(Unlicense)는 옛 tree-sitter-cli(0.20)로 빌드해 지금의 web-tree-sitter가 읽지 못해서, 같은 것을 새 CLI(0.26)로 다시 빌드한 갈래를 써요.
- clusters의 Louvain 방법(Blondel 등 2008)은 라이브러리 없이 직접 구현했어요. 새로 들인 부품이 없어요. 알고리즘과 출처 논문은 [docs/architecture.md](docs/architecture.md#질의-clusters)에 있어요.
- `proto/scip.proto`는 [scip-code/scip](https://github.com/scip-code/scip)(커밋 `be1d9f7`)에서 가져온 파일이에요. Apache-2.0이고 원문 라이선스는 `proto/LICENSE-scip`에 있어요.

## 문서

- [docs/architecture.md](docs/architecture.md): 그래프 스키마와 언어 어댑터 인터페이스, 질의 실행기
- [docs/contract.md](docs/contract.md): 답의 계약과 새 질의를 명령줄·MCP에 붙이는 법
