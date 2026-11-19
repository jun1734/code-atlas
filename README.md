# code-atlas

여러 언어의 코드를 이름(심볼) 단위로 색인해, 언어와 무관한 그래프 하나에 쌓고 질문을 던지는 도구예요.
"이 이름은 어디서 정의되고 어디서 쓰이나"를 문자열 검색이 아니라 컴파일러 수준 색인으로 답해요.

지금 되는 것: Dart 저장소 색인(scip-dart), 명령줄 `context`. 앞으로 붙을 것(impact, check, MCP 서버, Python·JS/TS)은 [jun1734/hijo#204](https://github.com/jun1734/hijo/issues/204)에 있어요.

## 준비

| 부품 | 버전 | 설치 |
| --- | --- | --- |
| Node.js | 24 이상 (`.ts`를 그대로 돌리고 내장 `node:sqlite`를 써요) | <https://nodejs.org> |
| Dart SDK | 3.5 이상 (Flutter SDK에 든 것도 돼요) | <https://dart.dev/get-dart> |
| scip-dart | 1.8.1 | `dart pub global activate scip_dart 1.8.1` |

```sh
npm ci
```

## 돌리는 법

```sh
# 색인: 저장소의 Dart 패키지(추적되는 pubspec.yaml마다)를 scip-dart로 색인해요.
# 패키지마다 pub get이 먼저 돼 있어야 해요(.dart_tool/package_config.json).
node src/cli.ts index path/to/repo

# 질문: 이름 하나의 정의 위치, 종류, 사용처
node src/cli.ts context withTax --repo path/to/repo
node src/cli.ts context Cart.add --repo path/to/repo   # 같은 이름이 여럿이면 바깥 타입을 붙여요
node src/cli.ts context withTax --repo path/to/repo --limit 20
```

- 답은 JSON이에요. `status`는 `found`, `ambiguous`(후보 목록 `candidates`), `not_found` 중 하나예요.
- 모든 답에 색인 기준 커밋(`index.commit`)과 낡았는지(`index.stale`: 색인 뒤 커밋이 바뀌었거나 작업 트리에 바뀐 파일이 있으면 `true`, git 저장소가 아니면 `null`)가 들어가요. 사용처에는 전체 개수(`total`)와 잘렸는지(`truncated`)가 들어가요.
- 항목마다 `confidence`(`precise` 정밀 / `inferred` 추정)와 `source`(어느 색인기)가 붙어요.
- 줄과 열은 1부터 세요.

색인 파일은 저장소 밖 `~/.code-atlas/<저장소이름>-<경로해시>.db`에 둬요. `--db`로 자리를 정하거나 `CODE_ATLAS_HOME`으로 폴더를 바꿔요.

### 색인은 저장소를 바꾸지 않아요

- scip-dart 산출물(`index.scip`)은 OS 임시 폴더에 쓰고 지워요.
- `pub get`을 대신 돌리지 않아요(네트워크를 쓰고 생성 파일을 만들어서요). `.dart_tool/package_config.json`이 없으면 할 일(`dart pub get` 또는 `flutter pub get`)을 알려 주고 멈춰요.
- 숨김 폴더(`.`으로 시작)와 `build` 폴더 안의 `pubspec.yaml`은 패키지로 보지 않아요.
- 색인 범위: scip-dart 1.8.1은 패키지 안의 Dart 파일을 모두 색인해요(`lib`, `bin`, `test` 등). #204는 "기본은 `lib`만, 테스트는 옵션"이라고 적었지만, 그건 scip-dart의 동작을 잘못 안 것이었어요. 테스트 사용처를 따로 보여 주는 일(#204 이야기 16)은 경로로 나눠서 해요.

### 측정 (2026-11-19, Windows 11 노트북)

hijo_app(Flutter, Dart 파일 329개, `lib`·`test` 포함): 색인 67초, DB 28MB, 심볼 5,790개, 관계 72,461개.
대부분 scip-dart(Dart 분석기) 시간이에요.

## 검사

```sh
npm run check      # 타입 검사(tsc --noEmit) + 테스트
```

테스트는 실제 scip-dart를 돌려요(가짜 SCIP 파일을 쓰지 않아요). 그래서 위 준비물이 모두 있어야 해요.
테스트는 `test/fixtures/<예제>`를 임시 git 저장소로 복사해 명령줄로 색인하고, 명령줄로 질문해 `test/expected/<예제>/`의 정답과 비교해요. 내부 모듈은 시험하지 않아요.

CI(`.github/workflows/ci.yml`)는 Linux(ubuntu)와 Windows 양쪽에서 같은 검사를 돌려요.

## 플랫폼 메모

- **Windows**: scip-dart 1.8.1은 Windows에서 경로와 심볼 문자열에 `\`를 넣어요(`` `lib\src\a.dart`/add(). ``). 그대로 두면 같은 심볼의 열쇠가 OS마다 달라져서, Dart 어댑터가 `/`로 바꿔요.
- **경로 인자 함정**: scip-dart에 패키지 경로를 `./`로 주면 패키지 전체를 "중첩 패키지"로 보고 파일을 0개 색인해요(오류 없이 빈 색인). 어댑터는 항상 절대 경로를 줘요.
- scip-dart 1.8.1이 색인 메타데이터에 적는 버전은 `1.7.0`이에요(그쪽 버전 상수가 갱신되지 않았어요). 동작과는 상관없어요.

## 라이선스 방침

- **무료 오픈소스 부품만 써요.** 상용 개발에 쓸 수 있는 라이선스(MIT, BSD, Apache-2.0 등)만 들여요. 비상업 전용(PolyForm Noncommercial 등)이나 유료 부품, 네트워크로 코드를 내보내는 서비스는 쓰지 않아요. 새 부품을 들일 때 라이선스를 먼저 확인해요.
- **GitNexus 코드는 복사하지 않아요.** GitNexus는 PolyForm Noncommercial이라 상용 개발에 쓸 수 없어요. 기능 아이디어만 참고해 다시 구현해요.
- 지금 쓰는 부품: scip-dart(Apache-2.0, 별도 설치), protobufjs(BSD-3-Clause), TypeScript(Apache-2.0, 개발용), @types/node(MIT, 개발용), Node 내장 `node:sqlite`·`node:test`.
- `proto/scip.proto`는 [scip-code/scip](https://github.com/scip-code/scip)(커밋 `be1d9f7`)에서 가져온 파일이에요. Apache-2.0이고 원문 라이선스는 `proto/LICENSE-scip`에 있어요.

## 문서

- [docs/architecture.md](docs/architecture.md): 그래프 스키마와 언어 어댑터 인터페이스
