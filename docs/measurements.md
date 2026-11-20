# hijo_app 실측 기록

code-atlas를 hijo_app(Flutter 앱, Dart가 대부분이고 `functions/`의 Python과 hook·스크립트의 JavaScript가 섞인 저장소)에 돌려 잰 값이에요. 2026-11-19에 GitNexus 1.6.12로 잰 값과 나란히 적어요. GitNexus는 PolyForm Noncommercial이라 다시 설치하지 않았고, 그날 잰 값을 그대로 써요.

## 잰 조건 (2026-11-20, hijo#229)

- 기계: Windows 11 노트북(논리 코어 20개). 다른 세션(편집기, 다른 에이전트)이 켜져 있었지만 잴 무렵 CPU 사용률은 10% 안팎이었어요.
- 도구: code-atlas `3a03fa7`(`feat/204-atlas-tools`, Dart·Python·JS/TS와 추정 층이 모두 들어간 때), Node 26.13.0, scip-dart 1.8.1, scip-python 0.6.8, scip-typescript 0.6.2, Flutter 3.47.9.
- 사본: `git clone --shared`로 hijo_app을 임시 폴더(어느 저장소에도 속하지 않는 곳)에 두 벌 꺼냈어요. 하나는 지금의 `main` **`322c149`**(색인 측정과 지금의 질문), 하나는 GitNexus를 잰 커밋 **`7ba0197`**(GitNexus와 같은 코드에 같은 질문). 원래 저장소는 건드리지 않았고, 사본과 색인 파일은 다 잰 뒤 지웠어요.
- `flutter pub get --offline`: 두 사본 모두 로컬 pub 캐시만으로 끝났어요(네트워크로 받은 패키지 없음).
- 색인 파일은 `CODE_ATLAS_HOME`을 임시 폴더로 돌려 따로 뒀어요. 시간과 크기는 `index`가 내는 요약(`ms`, `dbBytes`)이에요.

## 색인 (322c149)

### 크기

| 언어 | 파일 | 이름(심볼) | 관계 | 정밀 비율 | 추정 비율 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dart | 329 | 5,472 | 72,511 | 1.0 | 0 |
| JavaScript | 17 | 123 | 1,466 | 1.0 | 0 |
| Python | 16 | 320 | 1,330 | 1.0 | 0 |
| **전체** | **362** | **5,915** | **75,307** | | |

- DB: 30,081,024바이트(30.1MB). 파일 하나를 고쳐 다시 색인한 뒤 30,101,504바이트.
- 정밀 색인기 셋(scip-dart, scip-python, scip-typescript)이 모두 돌았고 `fallbacks`는 비었어요. 그래서 관계가 모두 정밀이에요. 정밀 층이 놓친 자리를 추정으로 메우는 경우(JSDoc의 이름, scip-python의 `global` 변수)는 hijo_app에 없었어요.
- 관계는 쓰인 자리마다 하나예요: `call` 26,142, `reference` 25,378, `read` 21,496, `import` 1,423, `write` 609, `extends` 210, `implements` 49.
- TypeScript 파일은 없어요(언어가 `javascript`인 17개뿐).

### 시간

| 경우 | 반영한 파일 | 색인기 | 그래프 반영 | 전체 |
| --- | --- | ---: | ---: | ---: |
| 처음 색인 | 362개 더함 | 75.7초 | 1.41초 | 77.5초 |
| 아무것도 안 바꾸고 다시 | 0개 | 70.5초 | 0.29초 | 71.2초 |
| `lib` 파일 하나에 최상위 함수 하나 더하고 다시 | 1개 바꿈 | 74.8초 | 0.31초 | 75.6초 |
| 그 파일을 되돌리고 다시 | 1개 바꿈 | 69.5초 | 0.29초 | 70.2초 |

색인기마다 나눠 보려고 정밀 색인기 일부를 끄고(`CODE_ATLAS_DISABLE_INDEXERS`, 끈 언어는 추정 층이 색인해요) 처음부터 다시 쟀어요.

| 정밀로 돈 색인기 | 색인기 | 전체 | 관계 | DB |
| --- | ---: | ---: | ---: | ---: |
| scip-dart만 (Python·JS는 추정) | 67.1초 | 69.0초 | 73,878 | 29.6MB |
| scip-python, scip-typescript (Dart는 추정) | 5.6초 | 6.5초 | 25,889 | 11.0MB |
| 없음 (모두 추정 층) | 1.8초 | 2.3초 | 24,460 | 10.6MB |

- 시간의 90% 넘게가 scip-dart예요. scip-dart 1.8.1은 패키지 단위로만 돌아서, 파일 하나를 고쳐도 처음 색인과 거의 같은 시간이 걸려요. 그래프 반영은 증분이라 0.3초예요.
- 추정 층만 쓰면 Dart의 관계가 72,511개에서 23,093개로 줄어요(이름 4,228개). 수신자 타입을 알아야 하는 멤버 사용처 등을 잇지 않기 때문이에요([architecture.md](architecture.md#추정-층이-놓치는-것-dart)).

### #218에서 잰 것과 비교

#218(2026-11-19)은 같은 노트북에서 hijo_app의 Dart 329개를 색인해 처음 84.4초, 다시 54.5초, 파일 하나 고치고 28.0초였어요. 그때는 다른 에이전트의 테스트가 함께 돌았어요. 이번에는 처음, 다시, 파일 하나 모두 70~76초로 고르게 나와서, 28초는 다시 나오지 않았어요. "다시 색인할 때 시간 대부분이 색인기 실행"이라는 #218의 결론은 그대로예요.

**판단(#218에서 이어짐): 색인기 실행을 줄일 값어치가 있어요.** 작업 중에 금방 최신이 되려면 이 70초를 줄여야 해요. 줄이는 길은 (1) 바뀐 파일이 없는 패키지는 색인기를 건너뛰기(hijo_app처럼 패키지가 하나인 저장소에는 효과가 없어요. 다른 패키지가 가리키는 이름이 바뀌면 그 패키지도 다시 돌려야 해요), (2) Dart 분석기를 띄워 둔 채 바뀐 파일만 다시 분석하는 상주 색인기(scip-dart를 고치거나 새로 짜야 해요) 중 하나예요.

## GitNexus와 나란히 (7ba0197)

GitNexus는 2026-11-19에 `7ba0197`의 `lib/`와 `test/`(Dart 320개 파일: `lib` 205개, `test` 115개)를 복사해 쟀어요. code-atlas는 같은 커밋의 저장소 전체를 색인했어요(Dart 320개는 같고, Python 14개와 JS 14개가 더 있어요).

| | GitNexus 1.6.12 | code-atlas (정밀) | code-atlas (추정 층만) | 옛 코드 지도 |
| --- | --- | --- | --- | --- |
| 색인 시간 | 23.8초 (명령 전체 43초) | 83.8초 (색인기 81.6초) | 322c149에서 2.3초 | 0.26초 |
| DB | 54MB | 27.8MB | 322c149에서 10.6MB | HTML 한 장(약 90KB) |
| 개수 | 노드 4,510 / 간선 10,040 | Dart 이름 5,297 / 관계 67,713 (전체 5,640 / 69,792) | | 파일 단위뿐 |
| 이름 단위 질문 | 함수·직접 import한 클래스는 맞고, provider·상수와 barrel을 거친 사용처는 놓침(아래) | 아래 질문 모두 맞음 | 아래 질문에서 한 곳 놓침 | 답하지 못함 |

- 개수는 단위가 달라 바로 비교하지 않아요. GitNexus의 노드에는 파일·폴더·묶음·실행 흐름이 함께 들고, code-atlas의 관계는 이름이 쓰인 자리마다 하나예요(같은 파일에서 열 번 쓰면 열 개).
- 시간은 GitNexus보다 3.5배쯤 길어요. 차이는 거의 다 scip-dart(Dart 분석기로 타입까지 푸는 것)예요. Tree-sitter로만 읽는 추정 층은 GitNexus보다 빨라요.

## GitNexus가 놓친 질문 다시 던지기

2026-11-19에 GitNexus에 던진 질문 가운데 놓친 것은 최상위 변수·provider 4개와 디자인 시스템 컴포넌트 2개였어요. 같은 이름을 `context <이름> --limit 1000`으로 물었어요.

- **GitNexus 날의 정답**: 그날 스크립트가 센 값이에요. `lib/`와 `test/`의 Dart 파일 가운데 정의 파일을 빼고, `//`로 시작하는 줄을 뺀 소스에 그 이름이 단어로 나오는 파일 수예요.
- **문자열 검색**: `git grep -n -w <이름> -- '*.dart'`의 줄 수예요. 줄 단위로 code-atlas의 사용처(경로:줄)와 하나하나 맞춰 봤어요.

### 파일 단위: GitNexus와 같은 코드(7ba0197)에서

| 이름 | 종류 | 정답 파일 | GitNexus | code-atlas 정밀 | code-atlas 추정 층 |
| --- | --- | ---: | --- | ---: | ---: |
| `loginTryLaterMessage` | 최상위 상수 | 6 | 0 | 6 | 5 |
| `entryGatesProvider` | provider | 4 | 0 | 4 | 4 |
| `pendingInviteProvider` | provider | 3 | 0 | 3 | 3 |
| `deletionRequestedAtProvider` | provider(`family`) | 2 | 0 | 2 | 2 |
| `HijoBottomNav` | barrel(`design_system.dart`)을 거쳐 쓰는 클래스 | 21 | 3 (엉뚱한 파일 1: barrel 자신) | 21 | 21 |
| `HijoColors` | barrel을 거쳐 쓰는 클래스 | 16 | 6 (엉뚱한 파일 23) | 16 | 16 |

code-atlas 정밀 층은 여섯 질문 모두 정답 파일과 같아요. 엉뚱한 파일도 없어요.

### 줄 단위: 문자열 검색과 맞춰 보기 (7ba0197, 정밀)

| 이름 | `git grep` 줄 | code-atlas 사용처 (줄) | 어긋난 줄과 원인 |
| --- | ---: | --- | --- |
| `loginTryLaterMessage` | 13 | 12 (12) | 1줄: 정의(`auth_error_message.dart:5`) |
| `entryGatesProvider` | 6 | 5 (5) | 1줄: 정의 |
| `pendingInviteProvider` | 9 | 8 (8) | 1줄: 정의 |
| `deletionRequestedAtProvider` | 3 | 2 (2) | 1줄: 정의 |
| `HijoBottomNav` | 58 | 56 (56) | 2줄: 클래스 선언(`:40`)과 이름 없는 생성자 선언 `const HijoBottomNav({`(`:41`). 정밀 어댑터는 생성자를 클래스로 합치고 선언 자리는 사용처로 세지 않아요 |
| `HijoColors` | 59 | 55 (51) | 8줄, 아래 |

`HijoColors`에서 문자열 검색에만 나오는 8줄:

- 생성자 선언 `const HijoColors({`(`hijo_colors.dart:11`): 위와 같은 이유예요.
- 글(문자열) 안: 오류 문구 `'HijoColors missing from ThemeData…'`(`hijo_colors.dart:347`), 테스트 이름 `'every HijoColors color has a row…'`(`design_docs_sync_test.dart:213`).
- `//` 주석 2줄(`design_docs_sync_test.dart:89`, `:212`).
- 문서 주석 속 백틱 언급 3줄(`` `HijoColors` ``: `hijo_theme.dart:9`, `hijo_palette.dart:6`, `hijo_typography.dart:17`). 백틱은 dartdoc 링크가 아니라서 Dart 분석기가 이름으로 풀지 않아요.

사용처 55곳이 51줄인 것은 한 줄에 두 번 쓴 곳이 4줄이라서예요(예: `hijo_colors.dart:290`, `components_test.dart:83`). 정의 줄(`hijo_colors.dart:10`)은 `ThemeExtension<HijoColors>`의 타입 인자가 실제 사용처라 들어가요.

문서 주석의 dartdoc 링크(`[entryGatesProvider]`처럼 대괄호로 쓴 이름)는 scip-dart가 사용처로 줘서 code-atlas 답에 들어가요. 위 표에서 이런 줄은 `entryGatesProvider` 1줄(`auth_gate.dart:21`), `pendingInviteProvider` 2줄(`invite_result_sections.dart:19`, `invite_handoff.dart:9`), `HijoBottomNav` 2줄(`hijo_bottom_nav.dart:11`, `app_shell.dart:14`), `HijoColors` 1줄(`share_card.dart:153`)이에요. 문자열 검색에도 나오는 줄이라 위 표의 차이에는 없지만, 사용처 수에 코드가 아닌 줄이 섞인다는 뜻이에요. 이제 이런 사용처는 `kind: reference`에 `doc: true`가 붙어 코드의 사용처와 가려져요(아래 "문서 주석 링크를 가른 뒤"). GitNexus 날의 정답은 `//`로 시작하는 줄(`///` 포함)을 빼고 셌지만, 이 줄들이 든 파일에는 모두 코드 사용처도 있어서(정의 파일인 `hijo_bottom_nav.dart`는 원래 빠져요) 파일 수는 같아요.

### 지금의 코드(322c149)에서

| 이름 | `git grep` 줄 | 정밀 사용처 (줄, 파일) | 어긋난 줄 | 추정 층 사용처 (줄) |
| --- | ---: | --- | --- | --- |
| `loginTryLaterMessage` | 14 | 13 (13, 8) | 정의 1줄(이제 `common/retry_messages.dart:7`) | 12 (12) |
| `entryGatesProvider` | 6 | 5 (5, 4) | 정의 1줄 | 4 (4) |
| `pendingInviteProvider` | 9 | 8 (8, 3) | 정의 1줄 | 6 (6) |
| `deletionRequestedAtProvider` | 0 | `not_found` | 없음. #200(커밋 `feb190e`)에서 계정 지우기 대기 관문과 함께 지워졌어요 | `not_found` |
| `HijoBottomNav` | 65 | 63 (63, 26) | 선언 2줄(`:40`, `:41`) | 62 (62) |
| `HijoColors` | 60 | 56 (52, 17) | 7ba0197과 같은 8줄 | 56 (52) |
| `signUpConsentsProvider` | 5 | 4 (4, 2) | 정의 1줄 | 4 (4) |
| `petMotionOffProvider` | 14 | 13 (13, 3) | 정의 1줄 | 12 (12) |

`signUpConsentsProvider`와 `petMotionOffProvider`는 #212에서 처음 맞춰 본 provider예요(그때 4/4, 13/13). 지금도 같아요.

### 추정 층(Tree-sitter)이 문자열 검색과 다른 곳

GitNexus처럼 Tree-sitter로 읽고 이름으로 잇는 층이지만, import와 barrel(`export`)을 따라 보이는 이름을 고르기 때문에 provider와 barrel을 거친 사용처를 찾아요. 처음 쟀을 때(code-atlas `3a03fa7`) 정밀 층과 다른 곳은 셋이었고, 둘은 고쳤어요(322c149 기준, 7ba0197도 같아요).

- **놓침, 코드 사용처 1곳** (그대로): `'$loginTryLaterMessage 인터넷 연결을…'`(`signup_consent.dart:231`). 중괄호 없이 글에 끼운 이름이에요. 이미 알려진 놓침이에요([architecture.md](architecture.md#추정-층이-놓치는-것-dart)). 그래서 파일 단위로도 6개 중 5개예요.
- **놓침, 문서 주석의 dartdoc 링크** (고침): 위에 적은 대괄호 링크(`entryGatesProvider` 1줄, `pendingInviteProvider` 2줄, `HijoBottomNav` 2줄, `HijoColors` 1줄, `petMotionOffProvider` 1줄)를 잇지 않았어요. 이제 추정 층도 `doc: true`로 내요.
- **더 셈, 생성자 선언 1줄** (고침): 이름 없는 `const` 생성자 선언(`const HijoBottomNav({`, `const HijoColors({`)을 클래스의 사용처로 셌어요. tree-sitter-dart가 `const` 생성자를 다른 노드(`constant_constructor_signature`)로 읽어서였어요.

### 문서 주석 링크를 가른 뒤 (2026-11-20, code-atlas `fix/204-followups`)

dartdoc 링크에 `doc: true`를 붙이고(정밀·추정 층 모두) 추정 층의 생성자 선언을 고친 뒤, 같은 사본 방법(`git clone --shared` 두 벌, `flutter pub get --offline`, 다 쓴 뒤 지움)으로 다시 물었어요. 정밀 층의 이름·관계 수는 그대로예요(7ba0197 5,640 / 69,792, 322c149 5,915 / 75,307). 모두 추정 층으로 색인하면 322c149에서 이름 4,650, 관계 24,748이에요.

| 이름 (7ba0197) | 사용처 | 코드 (줄, 파일) | 문서 링크 (`doc: true`) | 추정 층 |
| --- | ---: | --- | --- | --- |
| `loginTryLaterMessage` | 12 | 12 (12, 7) | 0 | 11: 위의 코드 1곳 놓침 |
| `entryGatesProvider` | 5 | 4 (4, 4) | 1 (`auth_gate.dart:21`) | 정밀과 같음 |
| `pendingInviteProvider` | 8 | 6 (6, 3) | 2 (`invite_result_sections.dart:19`, `invite_handoff.dart:9`) | 정밀과 같음 |
| `deletionRequestedAtProvider` | 2 | 2 (2, 2) | 0 | 정밀과 같음 |
| `HijoBottomNav` | 56 | 54 (54, 22) | 2 (`hijo_bottom_nav.dart:11`, `app_shell.dart:14`) | 정밀과 같음 |
| `HijoColors` | 55 | 54 (50, 17) | 1 (`share_card.dart:153`) | 정밀과 같음 |

- "정밀과 같음"은 사용처의 자리(경로:줄:열)와 `doc` 표시가 하나하나 같다는 뜻이에요. 322c149(`signUpConsentsProvider`, `petMotionOffProvider` 포함)도 같아요: 추정 층은 `signup_consent.dart:231` 한 곳만 달라요.
- 문서 링크가 든 파일에는 모두 코드 사용처도 있어서(정의 파일 `hijo_bottom_nav.dart`는 원래 빠져요) 파일 수는 바뀌지 않아요. 바뀐 것은 줄 단위 설명이에요: 어느 사용처가 코드가 아닌지 답에서 바로 보여요.
- `npm run verify:hijo`(check와 코드 지도 비교)는 그대로 통과해요.

## 찾은 것

- 정밀 층은 GitNexus가 놓친 여섯 질문을 모두 맞혔어요(파일 단위로 정답과 같고, 줄 단위 차이는 모두 정의·선언 줄이거나 주석·글 속 언급이에요).
- 사용처 수에 dartdoc 링크(코드가 아닌 줄)가 섞이지만, 이제 `doc: true`로 가려져요. context와 rename에는 표시와 함께 나오고(링크도 고쳐야 해요), impact·trace·flows·clusters·check는 의존으로 치지 않아요.
- 추정 층은 이 질문들에서 중괄호 없이 글에 끼운 이름 한 곳만 놓쳐요.
- 색인 시간은 GitNexus의 3.5배쯤이고 거의 다 scip-dart예요. 파일 하나를 고쳐도 70초쯤 걸려요(위 "판단").

## 이전 기록

### Python (2026-11-20, hijo_app 322c149의 `functions/`, #220)

hijo_app을 임시 폴더에 `git worktree add`로 꺼내 색인했어요(Dart는 pub get 없이 추정 층, Python은 scip-python). `functions/requirements.txt`가 있어 `functions/`가 Python 프로젝트 뿌리 하나예요. Python 파일 16개, 심볼 320개, 관계 1,330개로 모두 정밀이에요(위 "색인"의 Python 줄과 같아요). 가상 환경(`functions/venv`, .py 2,710개)을 둔 채로 돌려도 Pyright가 가상 환경을 빼서 scip-python이 읽은 파일은 16개, 실행은 1.8초쯤이었어요.

함수 하나의 사용처를 손으로 확인한 것과 비교했어요(`git grep -n -w <이름> -- '*.py'`에서 정의 줄과 주석·문서 문자열 속 언급을 뺀 것). 셋 다 같았어요.

| 함수 | 손으로 확인한 사용처 | code-atlas(정밀) | code-atlas(추정 층만) |
| --- | --- | --- | --- |
| `run_cleanup` (`cleanup.py`) | `main.py:193`(`cleanup.run_cleanup(`), `tests/test_cleanup.py:28`(import), `:106`(호출) | 같은 3곳(call, reference, call. 테스트 2곳은 `role: test`) | 같은 3곳 |
| `unlink_kakao_user` (`social/kakao_unlink.py`) | `cleanup.py:31`(import), `:248`(호출) | 같은 2곳 | 같은 2곳 |
| `new_record` (`login_records.py`) | `login_records.py:69`, `main.py:150`(`login_records.new_record(`) | 같은 2곳 | 같은 2곳 |

### JavaScript: hook과 스크립트 (2026-11-20, hijo_app 322c149, #221)

`git clone --shared` 사본에서 JS 파일 17개(`.claude/hooks/*.js`, `scripts/code-map/build.mjs`, `firestore_tests/`, `docs/research/…`)가 모두 scip-typescript로 정밀 색인됐어요(설정 파일 없음). `context commitDir`(`.claude/hooks/block-commit-on-main.js`)의 사용처 11곳(앱 1, 테스트 10)이 `git grep -n -w commitDir`의 14줄 가운데 정의 1줄, 내보내기 목록 1줄(`module.exports = { commitDir, … }`), 테스트의 `require` 구조 분해 1줄을 뺀 11줄과 같아요(모두 `call`, `precise`). 정밀 색인기를 끄고(추정 층만) 물어도 같은 11곳이 `inferred`로 나와요.
