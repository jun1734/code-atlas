# 구조: 그래프 스키마와 언어 어댑터

```
저장소 ──▶ 언어마다 정밀 어댑터 → (없거나 실패하거나 덮지 못한 파일) 추정 층 ──▶ 사실(Facts) ──▶ 그래프 저장소(SQLite) ──▶ 질의(context …) ──▶ 실행기(봉투) ──▶ 명령줄 / MCP
```

언어를 아는 곳은 어댑터(정밀 어댑터, 추정 규칙)뿐이에요. 그래프 저장소와 질의는 공통 형식의 사실만 알아요. 새 언어는 `src/languages.ts`의 `LANGUAGES`에 한 줄(정밀 어댑터, 추정 규칙, 또는 둘 다)과 예제 저장소 하나를 더해 붙여요.
새 질의는 `QueryDef` 하나를 `QUERIES`에 더해 붙여요. 명령줄과 MCP는 고치지 않아요(아래 "질의 실행기와 바깥 껍데기").

## 언어 어댑터 인터페이스

정의: `src/facts.ts`의 `LanguageAdapter`.

```ts
interface LanguageAdapter {
  readonly name: string;                 // 색인기 이름. 관계의 source로 남아요. 예: 'scip-dart'
  readonly language: string;             // 예: 'dart'
  readonly install: string;              // 색인기 설치 명령. 예: 'dart pub global activate scip_dart 1.8.1'
  applies(repo: RepoInfo): boolean;      // 이 저장소에 이 언어가 있는지
  isStandardLibrary(pkg: string): boolean; // 심볼 열쇠의 패키지 이름이 언어 기본 라이브러리(SDK)인지. 예: Dart의 'dart:async'
  toolState(repo: RepoInfo): ToolState[];  // 색인기가 읽지만 git이 무시해 커밋에 없는 파일 묶음(커밋 색인이 작업 트리에서 빌려 와요)
  index(repo: RepoInfo, workDir: string): Promise<Facts>;
}

interface ToolState {
  files: string[];                 // 빌려 올 파일(저장소 기준 경로). 작업 트리에 없으면 건너뛰어요
  sameAs: string[];                // 빌린 것이 그 커밋에 맞는지 가르는 파일(잠금 파일 등). 커밋과 작업 트리에서 다르면 그 색인기의 사실을 추정으로 낮춰요
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
- 색인기가 없으면 `IndexerMissing`(`src/facts.ts`)을 던져요. 그 밖의 실패는 보통의 오류예요. 어느 쪽이든 색인 전체는 멈추지 않고, 색인기(`src/indexer.ts`)가 안내를 내고 그 언어를 추정 층으로 색인해요(아래 "추정 층").

두 종류가 있어요.

- **정밀 어댑터**: 그 언어의 SCIP 색인기를 돌리고 `src/scip/to-facts.ts`로 SCIP 색인을 사실로 옮겨요. `confidence: 'precise'`. 지금은 Dart(`src/adapters/dart.ts`, scip-dart), Python(`src/adapters/python.ts`, scip-python), JavaScript/TypeScript(`src/adapters/typescript.ts`, scip-typescript)가 있어요.
- **추정 층**: Tree-sitter로 구문을 읽고 이름으로 이어요. `confidence: 'inferred'`. 언어마다 문법 하나와 작은 규칙(`InferredLanguage`)이에요. 지금은 Dart(`src/inferred/dart.ts`), Python(`src/inferred/python.ts`), JavaScript/TypeScript(`src/inferred/typescript.ts`)가 있어요. 아래 "추정 층".

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

### Python 어댑터가 더 하는 일

`src/adapters/python.ts`(scip-python 실행), `src/adapters/python-refine.ts`(다듬기), `src/adapters/python-conventions.ts`(관례, 추정 규칙과 함께 써요).

- **색인기**: scip-python 0.6.8(`@sourcegraph/scip-python`, MIT. Pyright의 갈래라 라이선스 파일도 Pyright의 MIT예요. 2026-11-20 확인). code-atlas의 npm 의존성이라 `npm ci`로 함께 깔려요. Python 해석기는 필요 없어요(Pyright는 Node로 돌아요).
- **프로젝트 뿌리**: `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`이 있는 폴더 가운데 다른 뿌리 안에 들지 않은 것마다 scip-python을 한 번 돌려요(`--cwd`가 그 폴더). 표시 파일이 하나도 없으면 저장소 뿌리 하나예요. 어느 뿌리에도 들지 않은 `.py` 파일은 추정 층이 메워요.
- **실행 옵션**: `--environment`에 빈 목록(`[]`)을 줘서 scip-python이 pip로 설치한 패키지를 묻지 않게 해요(저장소 밖 이름은 그래프에 넣지 않아요). `--project-version 0`으로 고정해요(주지 않으면 git 커밋이 들어가 커밋마다 심볼 열쇠가 바뀌어요). `--project-name`은 프로젝트 뿌리 경로(뿌리면 `.`)라 열쇠는 `scip-python python <뿌리> 0 \`<모듈>\`/<이름>`이에요(예: ``scip-python python . 0 `shop.pricing`/withTax().``).
- **빼는 파일**: 숨김 폴더와 `build/`, `dist/`, `__pycache__/`, `venv/`, `site-packages/`, `node_modules/` 안, 꼬리가 `_pb2.py`·`_pb2_grpc.py`인 파일, 머리(앞 1000자)에 `DO NOT EDIT`, `@generated`, `# Generated by`가 있는 파일. scip-python은 뿌리 아래 `.py`를 모두 읽어서(git이 무시하는 파일 포함) 결과에서 빼요.
- **테스트 파일**: `test/`·`tests/` 폴더 아래이거나 이름이 `test_*.py`, `*_test.py`, `conftest.py`면 `role: 'test'`.
- **정의의 종류**: scip-python 0.6.8은 `SymbolInformation.kind`를 주지 않아서 선언의 문법으로 정해요(추정 규칙과 같은 구문 읽기, 아래 "Python 규칙"). 정의 자체는 scip-python이 준 것이라 심볼의 `confidence`는 `precise`예요. 매개변수 심볼(`f().(x)`)은 넣지 않아요. 모듈 수준 변수에는 scip-python이 `enclosingRange`를 주지 않아서 대입문의 범위를 채워요(provider 안 사용처의 `in`).
- **import**: scip-python은 모듈을 `<모듈>/__init__:` 심볼로 가리켜요. 그 자리의 import 문을 Python 모듈 규칙(상대 import는 파일 폴더 기준, 절대 import는 프로젝트 뿌리, 그 아래 `src/`, 파일 폴더, 저장소 뿌리 순서)으로 파일에 풀어 파일→파일 `import` 관계로 바꿔요. 상대 import(`from .cart import …`)의 모듈 심볼은 scip-python이 패키지를 빼고 `cart/__init__:`로 적어서 심볼 이름으로는 풀 수 없어요. 모듈 심볼이 그 자리에 있다는 것(scip-python이 모듈로 풀었다는 것)은 정밀이라 `confidence`·`kindConfidence` 모두 `precise`예요.
- **사용처의 종류**: scip-python 0.6.8은 모든 사용처에 `ReadAccess`만 줘요(쓰기도 읽기로 나와요). 그래서 Dart처럼 문법으로 가려 `kindConfidence: inferred`로 둬요. 클래스 머리의 바탕 타입은 감싸는 클래스의 `supertypes`(scip-python이 준 `is_implementation` 관계)에 대상이 있을 때만 `extends`, `kindConfidence: precise`예요.
- **열쇠 고치기**: Windows에서 문서 경로가 `\`로 나와서 `/`로 바꿔요. 타입 표기가 붙은 모듈 수준 변수(`shippingFee: Final = 3000`)를 scip-python이 `shippingFee.shippingFee.`로 적어서 `shippingFee.`로 줄여요. 심볼 자체(모듈 이름)는 OS와 무관해요.
- **scip-python이 놓치는 것 → 추정으로 메움**: 다른 함수가 `global`로 다시 대입하는 모듈 변수를 `from m import x`로 가져오면 scip-python 0.6.8은 그 x를 지역 심볼(`local N`)로 적어서 그 import가 사용처에서 빠져요(python_sample의 `shop/__init__.py`가 `discountPercent`를 가져오는 곳). 그 자리에 정밀 관계가 없고, 모듈이 저장소 안 파일로 풀리고, 그 파일(또는 그 파일이 다시 가져온 곳)에 그 이름의 최상위 정의가 있으면 이어 주고 `confidence: inferred`(`source: scip-python`)로 표시해요.
- **Windows 덧대기**: scip-python 0.6.8은 Windows에서 시작하자마자 `new RegExp(path.sep, 'g')`(`'\'`는 정규식으로 잘못된 글)로 멈춰요. 어댑터는 scip-python을 `node -r src/adapters/scip-python-windows.cjs`로 띄워 그 한 정규식만 고쳐요. 또 `--cwd`는 절대 경로로 줘요(상대 경로면 빈 색인이 나와요).
- **알려진 한계**: 프로젝트의 가상 환경(`venv/`)을 Pyright에 알려 주지 않아서 설치한 패키지의 타입은 모르는 채로 색인해요. 저장소 안 이름의 사용처에는 영향이 없지만, 저장소 밖 함수가 돌려준 값의 메서드(`client().send()`의 `send`가 저장소 안 클래스의 것인지)는 이어지지 않을 수 있어요.

### JavaScript/TypeScript 어댑터 (scip-typescript)

`src/adapters/typescript.ts`(색인기 실행), `src/adapters/typescript-runner.ts`(자식 프로세스), `src/adapters/typescript-refine.ts`(다듬기), 관례는 `src/adapters/typescript-conventions.ts`. JavaScript와 TypeScript는 서로 가져다 쓰니 한 프로그램으로 함께 읽어서 `LANGUAGES`의 한 줄(`language: 'typescript'`)이에요. 파일의 `language`는 확장자대로 `typescript`(`.ts`·`.tsx`·`.mts`·`.cts`) 또는 `javascript`(`.js`·`.jsx`·`.mjs`·`.cjs`)예요.

- **scip-typescript는 npm 의존성이에요**(`@sourcegraph/scip-typescript` 0.6.2, `npm ci`로 함께 깔려요). 찾지 못하면 `IndexerMissing`이에요.
- **명령줄 대신 안의 `ProjectIndexer`를 불러요.** scip-typescript 명령줄은 프로젝트 폴더의 `tsconfig.json`을 그대로 쓰거나(색인할 파일을 고를 수 없어요), 없으면 `--infer-tsconfig`로 저장소에 `tsconfig.json`을 새로 써요. 저장소를 바꾸지 않으려고 자식 프로세스(`typescript-runner.ts`)에서 컴파일러 설정과 파일 목록을 만들어 `ProjectIndexer`에 바로 넘겨요. 프로젝트 뿌리(심볼 열쇠의 패키지와 경로를 정하는 곳)는 늘 저장소 뿌리예요(작업 폴더에 둔 설정 파일을 프로젝트로 주면 저장소 밖 파일로 보고 열쇠가 파일 이름만 남아요). 내부 API라 버전을 정확히(0.6.2) 묶었어요. scip-typescript가 stdout에 진행 글을 써서 자식 프로세스로 돌려요(MCP stdio를 더럽히지 않게). 자식에게도 부모의 Node 설정(`--import` 네트워크 차단 장치 포함)을 줘요.
- **색인하는 파일**: 저장소의 JS/TS 파일 전부(`git ls-files --cached --others --exclude-standard`), 설정 파일의 `include`와 상관없어요(스크립트 폴더처럼 include 밖 파일도 색인해요). 빼는 것: `node_modules/` 안, 패키지 뿌리(가장 가까운 `package.json` 폴더, 없으면 저장소 뿌리) 바로 아래의 `dist/`·`build/`·`out/`·`coverage/`, `*.min.js`·`*.bundle.js`, 머리(앞 1000자)에 `@generated`·`GENERATED CODE - DO NOT MODIFY`·`This file was generated`가 있는 파일. 숨김 폴더는 빼지 않아요(`.claude/hooks/*.js` 같은 것도 코드예요).
- **컴파일러 설정**: 파일마다 가장 가까운 `tsconfig.json`(같은 폴더에 없으면 `jsconfig.json`)의 `compilerOptions`를 쓰고, `allowJs: true`, `noEmit: true`를 덧씌워요. 설정 파일이 없는 파일(순수 JavaScript 폴더)은 기본 설정(ESNext, `moduleResolution: bundler`, `allowJs`, JSX 보존)이에요. 설정 파일을 읽지 못하면(설치되지 않은 패키지를 `extends`하는 등) 기본 설정이에요.
- **테스트 파일**: 경로에 `test/`·`tests/`·`__tests__/`·`spec/`·`__mocks__/` 폴더가 있거나 이름이 `*.test.*`·`*.spec.*`이면 `role: 'test'`.
- **넣지 않는 심볼**: 매개변수·타입 매개변수(scip-typescript는 전역 심볼로 적어요), CommonJS `module.exports = { a }`가 만든 속성 심볼(`a0:`).
- **열쇠 맞추기**: 생성자(`` Cart#`<constructor>`(). ``)는 클래스(`Cart#`)로 합쳐요. `new Cart()`는 클래스 `Cart`를 부르는 곳(`call`)이에요. getter·setter(`` Labeled#`<get>label`(). ``)는 그 이름(`Labeled#label.`)으로 합치고 종류를 `getter`/`setter`로 둬요(Dart 어댑터와 같아요).
- **사용처가 아닌 자리**: import의 이름(`import { a }`), require를 구조 분해한 이름(`const { a } = require('./x')`), 내보내기 목록(`export { a }`, `module.exports = { a }`, `exports.a = a`)은 scip-typescript가 occurrence로 적지만 넣지 않아요(Dart의 `show`/`hide` 이름처럼). 파일 → 파일 `import` 관계는 남아요. CommonJS의 `module.exports`는 scip-typescript가 그 파일 자신을 가리키는 occurrence로 적어서, 자기 자신으로 가는 import는 빼요.
- **사용처의 종류**: scip-typescript 0.6.2는 읽기/쓰기 역할을 주지 않아서(모두 역할 없음) 추정 층과 같은 추출기(`extractJsTs`)로 구문을 읽어 가려요(`kindConfidence: 'inferred'`). 부르면 `call`(`new X()` 포함), 대입의 왼쪽·`++`/`--`면 `write`, 그 밖의 값은 `read`, 타입 표기는 `reference`. `extends`/`implements`는 감싸는 타입의 `supertypes`(scip-typescript가 준 사실)에 대상이 있을 때만 `kindConfidence: 'precise'`예요.
- **정의 전체의 자리**: scip-typescript는 여러 줄에 걸친 변수 선언(`export const x = { … }`) 등에 `enclosingRange`를 주지 않아요. 같은 자리의 구문 정의로 채우고 사용처를 감싸는 심볼(`in`)을 다시 찾아요.
- **정밀 층이 잇지 못한 자리는 추정으로 메워요**(`fillGaps`). 추정 층을 같이 돌려, scip-typescript의 occurrence가 하나도 없는 자리(지역 이름·저장소 밖 이름도 occurrence가 있는 자리로 쳐요)에서 추정 층이 이은 사용처를 가져와요. 대상 열쇠는 같은 자리의 정밀 심볼 열쇠로 바꾸고, `confidence`·`kindConfidence`는 `inferred`, `source`는 `tree-sitter-typescript`예요. 지금 메우는 것은 JSDoc의 이름(`@implements {X}`, `@extends {X}`, `@type {X}`, `@param {X}` 등)이에요. TypeScript 검사기는 JSDoc 타입을 쓰지만 scip-typescript는 occurrence로 내지 않아요.
  - **수신자.이름은 메우지 않아요.** scip-typescript가 잇지 못한 멤버는 수신자가 `any`(JSON 답, 타입 없는 외부 모듈 등)인 자리예요. 같은 이름 멤버가 하나뿐이면 잇는 추정 층의 규칙을 그대로 쓰면, code-atlas 자신을 색인했을 때 288곳이 메워졌는데 대부분 틀렸어요(`answer.status` → `CliResult.status`, 배열의 `.map` → `RepoConfig.map` 등). 그래서 이름(수신자 없는) 자리만 메워요. 타입 없는 JavaScript에서 `x.method()`의 수신자를 모르면 그 사용처는 답에 없어요(JSDoc 타입을 달면 정밀로 잡혀요).

**한계**

- 저장소 밖 패키지의 타입은 그 패키지가 `node_modules`에 깔려 있을 때만 알아요(색인기는 `npm install`을 대신 돌리지 않아요). 깔려 있지 않으면 그 패키지에서 온 값은 `any`라 그 값의 멤버는 잇지 못해요. 저장소 안 이름 사이의 관계는 상관없어요.
- `tsconfig.json`의 `references`(프로젝트 참조)와 workspace 설정은 따로 보지 않아요. 파일마다 가장 가까운 설정 파일의 `compilerOptions`만 써요(`paths` 별칭은 그 설정 파일 기준으로 풀려요).
- JSDoc의 `@interface`는 보지 않아요. JavaScript에서 `@interface`를 단 클래스는 `class`예요.

## 추정 층

정밀 색인기가 없거나 실패한 언어, 그리고 정밀 색인기가 덮지 못한 파일(예: Dart 패키지 밖의 스크립트)을 Tree-sitter로 읽어 색인해요. 여기서 나온 심볼과 관계는 모두 `confidence: 'inferred'`, `kindConfidence: 'inferred'`, `source: 'tree-sitter-<언어>'`예요.

### 색인기의 순서와 대신 색인하기

`src/indexer.ts`의 `indexLanguage`. 언어 목록은 `src/languages.ts`의 `LANGUAGES`(`{ language, precise?, inferred? }`)예요.

1. 언어가 있는지: 정밀 어댑터의 `applies`가 참이거나, 추정 규칙의 `owns`에 맞는 파일이 있으면.
2. 정밀 어댑터를 돌려요. 이름이 환경 변수 `CODE_ATLAS_DISABLE_INDEXERS`(쉼표로 여럿)에 있으면 돌리지 않고 "설치되어 있지 않음"으로 쳐요. 테스트가 색인기를 지우지 않고 "없을 때"를 만드는 장치예요(정밀 색인기가 말썽일 때 추정 층만 쓰는 데도 써요).
3. 정밀 어댑터가 `IndexerMissing`을 던지면 `reason: 'missing'`, 다른 오류면 `'failed'`예요. stderr에 무엇이 없는지(실패했는지), 설치 명령(`install`), 그 언어를 추정 층으로 색인했다는 것을 적고, 색인 요약의 `fallbacks`에 남겨요. 색인 전체는 멈추지 않아요. 추정 규칙이 없는 언어는 안내만 내고 건너뛰어요(`inferredBy: null`).
   - Dart: `scip-dart`가 없으면 missing, 패키지 설정(`.dart_tool/package_config.json`)이 없는 패키지가 있으면 failed예요(지금은 패키지 하나만 실패해도 그 언어 전체가 추정 층으로 가요).
   - Python: code-atlas의 `node_modules`에 `@sourcegraph/scip-python`이 없으면 missing, scip-python이 실패하면 failed예요(프로젝트 뿌리 하나만 실패해도 그 언어 전체가 추정 층으로 가요).
   - JavaScript/TypeScript: code-atlas의 `node_modules`에 `@sourcegraph/scip-typescript`가 없으면 missing, scip-typescript 자식 프로세스가 실패하면 failed예요. 설정 파일이 없어서 실패하지는 않아요(기본 설정으로 색인해요).
4. 정밀 사실이 덮지 못한 이 언어의 파일(정밀 사실의 `files`에 없고, 추정 규칙의 `excluded`에도 걸리지 않는 파일)이 있으면 추정 층을 돌려요. 없으면 돌리지 않아요(정밀 색인이 모두 덮은 저장소는 Tree-sitter를 읽지도 않아요).

**정밀 사실은 덮어쓰지 않아요.** 추정 층은 정밀 사실이 있는 파일을 읽기는 하지만(이름 잇기에 그 파일의 정의와 import가 필요해요) 그 파일의 사실(파일, 정의, 그 파일에 적힌 관계)은 내지 않아요(`InferredRun.emit`). 색인기가 한 번 더 걸러요(`withoutCovered`). 추정 층의 관계가 정밀 파일의 이름을 가리킬 때는 같은 자리(경로, 이름의 줄·열)의 정밀 심볼 열쇠로 이어요. 그래서 패키지 밖 스크립트에서 패키지의 `Cart`를 쓰면, 정의는 정밀 그대로이고 그 사용처 하나만 추정으로 붙어요.

### 언어 하나의 추정 규칙 (`InferredLanguage`)

정의: `src/inferred/layer.ts`. 새 언어는 이것 하나를 만들어 `LANGUAGES`에 올려요. 이름 잇기, 파일 고르기, 정밀 사실과 섞기, 열쇠 만들기는 공통 부품이 해요.

```ts
interface InferredLanguage {
  language: string;                       // 정밀 어댑터의 language와 같게(예: 'dart')
  grammar: string;                        // @repomix/tree-sitter-wasms의 문법 이름(dart, python, javascript, typescript, tsx …)
  grammarFor?(path: string): string;      // 파일마다 문법이 다를 때(.tsx 등)
  fileLanguage?(path: string): string;    // 파일마다 언어 이름이 다를 때(JS/TS: javascript, typescript). 없으면 language
  owns(path: string): boolean;            // 이 언어의 파일인지(확장자)
  excluded(path: string, text: string, repo: RepoView): boolean; // 생성된 코드, 빌드 산출물
  role(path: string, repo: RepoView): 'app' | 'test';
  extract(root: SyntaxNode, text: string): FileSyntax;          // 구문 나무 → 정의, 사용처, import
  resolveImport(fromPath: string, spec: string, repo: RepoView): string | null; // import 대상 → 저장소 안 경로(밖이면 null)
  isCodeIdentifier(node: SyntaxNode): boolean; // 코드에 적힌 식별자인지(주석·글 안이 아님, 글에 끼운 식 안은 코드). rename이 써요
}

interface FileSyntax {
  definitions: { name; kind; range; enclosingRange; parent?: number }[];  // parent: 바깥 정의의 번호(멤버면 그 타입)
  references: { name; range; kind; in?: number; member?: { qualifier?: string } }[];
  imports: { spec; range; reexport: boolean; emit: boolean; sharesScope?: boolean }[];
}
```

- `references[].kind`는 문법으로 가린 종류(`call`, `read`, `write`, `reference`, `extends`, `implements`)예요. 이은 대상이 타입인데 `read`면 공통 부품이 `reference`로 바꿔요.
- `member`: `수신자.이름`의 이름이면 붙여요. `qualifier`는 수신자가 이름 하나일 때 그 이름이에요. `this.x`(Python `self.x`)는 `member` 없이 내요(감싸는 타입의 멤버부터 찾아요).
- 지역 이름(매개변수, 지역 변수)은 규칙이 걸러서 `references`에 넣지 않아요.
- `imports`: `reexport`는 가져온 파일의 이름을 다시 내보내는지(Dart `export`·`part`, JS `export * from`), `emit`은 파일→파일 `import` 관계로 넣을지, `sharesScope`는 가져온 파일과 이름 공간을 함께 쓰는지(Dart `part of`)예요.
- `isCodeIdentifier`는 보통 `isCodeIdentifierIn(node, { identifier, text, embedded })`에 그 문법의 노드 이름(식별자, 글·주석, 글에 끼운 식)을 줘요(`src/inferred/tree-sitter.ts`). 파일 글의 여러 자리를 한 번에 가리는 것은 `codeIdentifiersAt`(layer.ts)예요.
- 파서는 `src/inferred/tree-sitter.ts`의 `parserFor(grammar)`예요. web-tree-sitter의 노드는 꺼낼 때마다 새 객체라 `===`로 비교하지 않고 `same(a, b)`를 써요.
- 저장소의 파일 목록은 `git ls-files --cached --others --exclude-standard`(git이 무시하는 파일 빼고, 커밋하지 않은 새 파일 포함)예요. git 저장소가 아니면 숨김 폴더와 `node_modules`를 빼고 훑어요.

### 이름 잇기 (`runInferred`)

- **보이는 파일**: 파일 자신, 가져온 파일과 그 파일이 다시 내보내는 파일(이어서), `sharesScope`로 묶인 파일이 보는 파일. barrel을 거친 사용처가 이렇게 이어져요.
- **이름**(`member` 없음): 감싸는 타입들의 멤버 가운데 그 이름 → 보이는 파일의 최상위 정의 가운데 그 이름. 하나뿐일 때만 이어요.
- **멤버**(`member` 있음): `qualifier`가 타입 이름으로 풀리면 그 타입의 멤버. 아니면 같은 이름의 멤버가 저장소에 하나뿐일 때, 그다음 보이는 파일에 하나뿐일 때 이어요.
- **여럿이면 잇지 않아요.** 같은 이름이 여럿인데 하나를 고르면 다른 것을 가리키는 관계가 생겨서요. 놓치는 쪽을 골랐어요(아래 적합성 표의 `method-via-receiver`).
- 저장소 밖 이름(SDK, 패키지)은 잇지 않아요(정밀 층은 저장소 밖 심볼로 잇지만, 그런 심볼은 답에 나오지 않아요).
- **열쇠**: `<출처> <경로> <바깥 정의부터의 기술자>`(타입 `Name#`, 부르는 것 `name().`, 값 `name.`). 예: `tree-sitter-dart lib/src/cart.dart Cart#add().` 경로와 이름에서만 나와서 OS와 무관하고 다시 색인해도 같아요. 같은 열쇠가 또 나오면(getter와 setter) 뒤에 `~2`를 붙여요.

### Dart 규칙 (`src/inferred/dart.ts`)

- 파일 고르기와 역할은 정밀 어댑터와 같은 관례(`src/adapters/dart-conventions.ts`)를 가장 가까운 `pubspec.yaml` 폴더 기준으로 써요. 패키지 밖 파일은 저장소 뿌리 기준이에요.
- 정의: 클래스(`abstract interface class`는 `interface`), mixin, enum(값은 `field`), extension, typedef(`type`), 함수, 메서드, getter, setter, 이름 있는 생성자(`constructor`), 필드, 최상위 변수(`const`면 `constant`). 이름 없는 생성자는 정의를 만들지 않고 클래스에 속해요(정밀 어댑터가 클래스로 합치는 것과 같아요). 함수와 메서드의 `enclosingRange`는 시그니처부터 본문 끝까지예요.
- 사용처의 종류: `extends`·`with` 뒤 타입은 `extends`, `implements`·mixin의 `on` 뒤 타입은 `implements`, 뒤에 인자 목록이 오거나 `new`/`const`로 만들면 `call`, 대입의 왼쪽 끝이나 `++`/`--`면 `write`, 그 밖의 값은 `read`, 타입 표기는 `reference`예요.
- import: `import`·`export`(다시 내보냄)·`part`(다시 내보냄)는 관계로 넣고, `part of`는 넣지 않고 이름 공간만 함께 써요(정밀 어댑터의 `dropPartOf`와 같은 결과). `package:<이름>/…`는 저장소 안 `pubspec.yaml`의 `name`이 같은 패키지의 `lib/`로, 상대 경로는 파일 폴더 기준으로 풀어요. `dart:`와 저장소 밖 패키지는 잇지 않아요.

### 추정 층이 놓치는 것 (Dart)

- 수신자의 타입을 알아야 고를 수 있는 멤버(같은 이름 멤버가 여럿일 때): 이어지지 않아요. 같은 이름 멤버가 하나뿐이면 수신자가 무엇이든 이어요(예: `List`의 `add`를 저장소의 유일한 `add` 메서드로 이을 수 있어요).
- 같은 이름의 최상위 정의가 보이는 파일에 여럿이면 잇지 않아요. `show`/`hide`는 보지 않아요. import 접두사를 거친 사용처(`import … as p` 뒤의 `p.withTax`)는 놓쳐요.
- 지역 이름은 정의가 든 함수 전체에서 하나의 범위로 봐요. 그래서 함수 안 어디서든 같은 이름의 지역 이름이 있으면 그 함수 안의 같은 이름 최상위 정의 사용처를 놓쳐요.
- tree-sitter-dart가 `Provider<Cart>(…)` 같은 제네릭 호출을 비교식으로 읽어요. 그래도 `Cart`는 타입으로 이어져 `reference`가 되고, `Provider`는 저장소 밖이라 잇지 않아요.
- 추정 층의 `extends`·`implements`도 `kindConfidence: inferred`예요(정밀 층은 scip-dart의 타입 관계로 확인해 `precise`).
- 글 끼워 넣기에서 중괄호 없이 쓴 이름(`'연결 $roomName'`)은 사용처로 잇지 않아요(`test/flows.test.ts`가 이 놓침을 기록해요).

### 추정 층 적합성: dart_sample

언어 적합성 묶음(`test/conformance.test.ts`)을 추정 층으로도 돌린 결과예요. 정밀 색인기를 없는 것으로 치고 색인해, 표시(`confidence`, `kindConfidence`, `source`, `key`)를 뺀 답이 정밀 정답과 같으면 통과, 다르면 놓침이에요. 이 표는 테스트가 읽어서 실제와 맞는지 봐요(질문이 늘거나 결과가 바뀌면 테스트가 실패해요). 놓친 질문의 답은 `test/expected/dart_sample/conformance-inferred/`에 있어요.

| 질문 | 결과 | 비고 |
| --- | --- | --- |
| `module-function` | 통과 | 호출, 함수 값으로 읽기, barrel을 거친 사용처, 앱/테스트 |
| `module-constant` | 통과 | |
| `module-variable` | 통과 | 쓰기(`=`, `+=`)와 읽기 |
| `provider` | 통과 | |
| `provider-dependent` | 통과 | |
| `class` | 통과 | 생성자 호출, 상속, 타입 표기. 상속의 `kindConfidence`만 정밀 층(`precise`)과 달라요 |
| `interface` | 통과 | 구현(`kindConfidence: inferred`) |
| `mixin` | 통과 | 섞기(`extends`, `kindConfidence: inferred`) |
| `getter` | 통과 | 같은 이름 멤버가 하나뿐이라 이어져요 |
| `method-via-receiver` | 놓침 | `Cart.total`의 사용처 4곳을 모두 놓쳐요. 수신자(provider가 돌려준 값, `Cart()`의 결과)의 타입을 모르고 `Totaled.total`과 이름이 같아서 잇지 않아요 |
| `same-name-method` | 통과 | |
| `same-name-method-pick` | 통과 | |
| `same-name-function-pick-by-key` | 통과 | 추정 열쇠로 다시 물어도 하나가 나와요 |
| `file` | 통과 | |
| `file-barrel` | 통과 | |
| `excluded-symbol` | 통과 | |
| `excluded-file` | 통과 | |

### Python 규칙 (`src/inferred/python.ts`)

- 파일 고르기와 역할, import 풀기는 정밀 어댑터와 같은 관례(`src/adapters/python-conventions.ts`)를 써요(아래 "Python 어댑터가 더 하는 일").
- 정의: 클래스(`Protocol`을 바탕으로 하면 `interface`), 모듈 수준 함수(`function`), 메서드(`method`, `__init__`는 `constructor`, `@property`·`@cached_property`는 `getter`, `@x.setter`는 `setter`), 모듈 수준 변수(`variable`, 타입 표기가 `Final`이거나 이름이 대문자·밑줄뿐이면 `constant`), 클래스 본문의 변수(`field`), 메서드 안 `self.x = …`의 x(클래스에 처음 나오는 자리, `field`). 같은 층에 같은 이름을 다시 대입하면 정의가 아니라 쓰기예요. 모듈·클래스 수준의 `if`/`try`/`with` 안 정의도 그 층의 정의예요. 함수 안의 함수·클래스는 지역 이름이에요.
- 변수의 `enclosingRange`는 대입문 전체예요. 그래서 `totalProvider = lambda: cartProvider()…` 안의 사용처는 `in: totalProvider`예요.
- 사용처의 종류: 부르면(`f(…)`, 데코레이터) `call`, 대입·`+=`·`for`·`del`·`:=`의 대상이면 `write`, 클래스 머리의 바탕 타입이면 `extends`, `import` 문 안의 이름·`global` 선언·타입 표기는 `reference`, 그 밖은 `read`예요. Python의 바탕 타입은 상속 하나뿐이라 `implements`는 쓰지 않아요(Protocol을 바탕으로 둬도 `extends`).
- 지역 이름: 매개변수, 함수 안에서 대입한 이름(`global`·`nonlocal`로 밝힌 이름은 빼요), `for`·`with … as`·`except … as`·`:=`의 이름, lambda 매개변수, 컴프리헨션 변수. 함수 안 어디서든 대입하면 함수 전체에서 지역이에요.
- 멤버: `self.x`·`cls.x`는 감싸는 타입의 멤버부터 찾는 이름으로 내요. `모듈.x`는 그 모듈의 최상위 이름 x로 내요. 모듈인지는 `import m`·`import a.b as m`이 묶은 이름이면 확실하고, `from P import m`의 m은 소문자로 시작하면 모듈로 봐요(PEP 8: 모듈 이름은 소문자, 클래스는 CapWords).
- import: `import a.b`는 모듈 a.b로 가는 관계(다시 내보내지 않음). `from P import n`은 P로 가는 관계에, n이 하위 모듈(`P.n` 파일)로 풀리면 그 파일로 가는 관계를 더해요. Python에서 가져온 이름은 그 모듈의 이름이 되니 from … import는 다시 내보냄(`reexport`)이에요. 그래서 `__init__.py`(barrel)를 거친 사용처가 이어져요. `from . import x`처럼 모듈이 점뿐이면 패키지 자체로 가는 관계는 넣지 않아요(정밀 층과 같아요).

### 추정 층이 놓치는 것 (Python)

- 수신자의 타입을 알아야 고를 수 있는 멤버(같은 이름 멤버가 여럿일 때): 이어지지 않아요(Dart와 같아요).
- import는 파일 단위로 봐요. `from m import a`가 a만 가져와도 m의 최상위 이름이 모두 보여요. 그래서 보이는 파일에 같은 이름이 여럿이면 잇지 않아요.
- `from m import a as b` 뒤의 `b(…)`, `import a.b`의 `a.b.f`처럼 두 칸 넘는 모듈 경로는 놓쳐요.
- 메서드 안의 맨 이름(`f()`)도 감싸는 클래스의 멤버부터 찾아요(추정 층 공통 규칙). Python에서는 맨 이름이 클래스 멤버를 가리키지 않으니, 모듈 함수와 같은 이름의 메서드가 그 클래스에 있으면 메서드로 잘못 이을 수 있어요.
- 저장소 밖 이름(표준 라이브러리, 설치한 패키지)은 잇지 않아요.

### 추정 층 적합성: python_sample

dart_sample과 같은 방법이에요(정밀 색인기 `scip-python`을 없는 것으로 치고 색인해 표시를 뺀 답을 정밀 정답과 비교). 놓친 질문의 답은 `test/expected/python_sample/conformance-inferred/`에 있어요.

| 질문 | 결과 | 비고 |
| --- | --- | --- |
| `module-function` | 통과 | 호출, 함수 값으로 읽기, barrel(`shop/__init__.py`)을 거친 사용처, import 문의 이름, 앱/테스트 |
| `module-constant` | 통과 | `Final` 표기로 상수 |
| `module-variable` | 통과 | `global`로 밝힌 함수 안의 쓰기, `모듈.이름`으로 읽기. 정밀 층에서 barrel의 import 한 곳이 `confidence: inferred`인 것은 표시라 비교에서 빠져요(아래 "Python 어댑터가 더 하는 일") |
| `provider` | 통과 | provider는 함수 값(lambda)을 담은 모듈 수준 변수예요 |
| `provider-dependent` | 통과 | |
| `class` | 통과 | 생성자 호출, 상속, 타입 표기. 상속의 `kindConfidence`만 정밀 층(`precise`)과 달라요 |
| `interface` | 통과 | Protocol을 바탕으로 둔 곳(`extends`) |
| `mixin` | 통과 | 바탕 타입으로 섞기(`extends`) |
| `getter` | 통과 | `@property`. 같은 이름 멤버가 하나뿐이라 이어져요 |
| `method-via-receiver` | 놓침 | `Cart.total`의 사용처 4곳을 모두 놓쳐요. 수신자(provider가 돌려준 값, `Cart()`의 결과)의 타입을 모르고 `Totaled.total`과 이름이 같아서 잇지 않아요 |
| `same-name-method` | 통과 | |
| `same-name-method-pick` | 통과 | |
| `same-name-function-pick-by-key` | 통과 | 추정 열쇠로 다시 물어도 하나가 나와요 |
| `file` | 통과 | |
| `file-barrel` | 통과 | |
| `excluded-symbol` | 통과 | |
| `excluded-file` | 통과 | |

### JavaScript/TypeScript 규칙 (`src/inferred/typescript.ts`)

- 문법은 파일마다 골라요(`grammarFor`): `.tsx`는 `tsx`, TypeScript는 `typescript`, JavaScript(JSX 포함)는 `javascript`. 파일의 `language`는 `fileLanguage`로 `typescript`/`javascript`예요. 출처 이름은 둘 다 `tree-sitter-typescript`예요.
- 파일 고르기와 역할은 정밀 어댑터와 같은 관례(`src/adapters/typescript-conventions.ts`)예요.
- 정의: 클래스(`abstract` 포함), 인터페이스, 타입 별칭(`type`), enum(값은 `constant`), namespace, 함수, 메서드, getter, setter, 필드(클래스 필드, TypeScript 매개변수 속성, 인터페이스의 속성), 최상위 변수(`const`면 `constant`). 생성자는 정의를 만들지 않고 클래스에 속해요. `export`·`export default`·`declare` 안의 선언도 같아요.
- 사용처의 종류: `extends` 뒤는 `extends`, `implements` 뒤는 `implements`, JSDoc의 `@implements {X}`는 `implements`, `@extends {X}`(`@augments`)는 `extends`. 부르면(`f()`, `new X()`) `call`, 대입의 왼쪽이나 `++`/`--`면 `write`, 그 밖의 값은 `read`, 타입 표기와 JSDoc 타입(`@type {X}`, `@param {X}` …)은 `reference`예요.
- 지역 이름은 정의가 든 함수 전체(안쪽 함수 포함)를 한 범위로 봐요(Dart와 같아요). 파일 최상위 문장 안(블록, `test(…, () => {})` 같은 콜백)의 지역 이름은 파일 하나를 한 범위로 봐요.
- import: ES 모듈(`import … from`, `export … from`은 다시 내보냄), CommonJS(`require('x')`, `module.exports = require('x')`와 `module.exports = { ...require('x') }`는 다시 내보냄), 동적 `import('x')`. 상대 경로는 꼬리를 붙여 보고(`.ts`, `.tsx`, `.js` …), `.js`로 적은 TypeScript 파일(`./a.js` → `a.ts`)과 폴더의 `index`도 찾아요. 저장소 안 다른 `package.json`의 `name`으로 가져오면 그 폴더 안에서 찾아요(작업 공간). 그 밖의 패키지는 잇지 않아요.
- 모듈을 통째로 받은 이름: 저장소 안 모듈(`import * as p from './p'`, `const p = require('./p')`)의 `p.x`는 이름 `x`로 찾아요. 저장소 밖 모듈(`const path = require('path')`)의 `path.x`는 잇지 않아요(같은 이름 멤버로 잘못 잇지 않게).
- 이름을 가져오거나 내보내기만 하는 자리(import 이름, require 구조 분해, 내보내기 목록)는 사용처가 아니에요. 정밀 어댑터에 그 자리를 알려 줘요(`bindings`).

### 추정 층이 놓치는 것 (JavaScript/TypeScript)

- Dart와 같아요: 수신자의 타입을 알아야 고를 수 있는 멤버(같은 이름 멤버가 여럿일 때)는 잇지 않아요. 같은 이름 멤버가 하나뿐이면 수신자가 무엇이든 이어요.
- 별칭으로 가져온 이름(`import { a as b }`, `const { a: b } = require()`)의 사용처(`b`)는 놓쳐요. default import도 놓쳐요.
- `tsconfig.json`의 `paths` 별칭(`@/x`)은 풀지 않아요(정밀 층은 풀어요).

### 추정 층 적합성: ts_sample

TypeScript 예제(`test/fixtures/ts_sample`, `tsconfig.json`이 있는 ES 모듈). mixin 문법이 없어서 `Labeled`는 바탕 클래스, provider는 작은 `Container`가 읽는 모듈 수준 함수예요. 최상위 변수에 쓰는 곳은 그 파일 안(`setDiscount`)이에요(ES 모듈의 가져온 변수에는 쓸 수 없어요). 정밀 층의 답은 모두 정밀(`scip-typescript`)이에요.

| 질문 | 결과 | 비고 |
| --- | --- | --- |
| `module-function` | 통과 | 호출, 함수 값으로 읽기, barrel(`export *`)을 거친 사용처, 앱/테스트 |
| `module-constant` | 통과 | |
| `module-variable` | 통과 | 쓰기(`=`, `+=`)와 읽기 |
| `provider` | 통과 | |
| `provider-dependent` | 통과 | |
| `class` | 통과 | `new` 호출, 상속, 타입 표기. 상속의 `kindConfidence`만 정밀 층(`precise`)과 달라요 |
| `interface` | 통과 | 구현 |
| `mixin` | 통과 | 바탕 클래스 상속(`extends`) |
| `getter` | 통과 | 같은 이름 멤버가 하나뿐이라 이어져요 |
| `method-via-receiver` | 놓침 | `Cart.total`의 사용처 4곳을 모두 놓쳐요. 수신자(`container.read(cartProvider)`가 돌려준 값, `new Cart()`의 결과)의 타입을 모르고 `Totaled.total`과 이름이 같아서 잇지 않아요 |
| `same-name-method` | 통과 | |
| `same-name-method-pick` | 통과 | |
| `same-name-function-pick-by-key` | 통과 | 추정 열쇠로 다시 물어도 하나가 나와요 |
| `file` | 통과 | |
| `file-barrel` | 통과 | |
| `excluded-symbol` | 통과 | `// @generated` 파일, `dist/`, git이 무시하는 `local/` |
| `excluded-file` | 통과 | |

### 추정 층 적합성: js_sample

JavaScript 예제(`test/fixtures/js_sample`): 설정 파일(`package.json`, `tsconfig.json`, `jsconfig.json`)이 하나도 없는 CommonJS(`require`, `module.exports`) 폴더예요. barrel은 `module.exports = { ...require('./cart'), … }`예요. 인터페이스는 JSDoc(`@interface`가 붙은 클래스와 `@implements {Totaled}`), 타입 표기는 JSDoc `@type {Cart}`예요. `Container.read`에 JSDoc 타입(`@template`)이 있어서 정밀 층이 돌려준 값의 타입(`Cart`)을 알아요.

정밀 층의 답에도 추정 항목이 있어요(정답 파일에 그대로 있어요): JSDoc `@implements {Totaled}`(`interface`의 사용처 하나), JSDoc `@type {Cart}`(`class`의 `src/main.js` 12줄)는 scip-typescript가 occurrence로 내지 않아 정밀 어댑터가 추정 층으로 메워요(`confidence: inferred`, `source: tree-sitter-typescript`).

| 질문 | 결과 | 비고 |
| --- | --- | --- |
| `module-function` | 통과 | 내보내기 목록(`module.exports = { withTax }`)은 사용처가 아니에요 |
| `module-constant` | 통과 | |
| `module-variable` | 통과 | |
| `provider` | 통과 | |
| `provider-dependent` | 통과 | |
| `class` | 통과 | |
| `interface` | 통과 | JSDoc `@implements` |
| `mixin` | 통과 | |
| `getter` | 통과 | |
| `method-via-receiver` | 놓침 | ts_sample과 같아요(4곳을 모두 놓쳐요) |
| `same-name-method` | 통과 | |
| `same-name-method-pick` | 통과 | |
| `same-name-function-pick-by-key` | 통과 | |
| `file` | 통과 | |
| `file-barrel` | 통과 | |
| `excluded-symbol` | 통과 | |
| `excluded-file` | 통과 | |


## 그래프 스키마

정의: `src/graph/store.ts`. SQLite 파일 하나, 저장소 밖에 둬요.

| 표 | 열 | 뜻 |
| --- | --- | --- |
| `meta` | `key`, `value` | `schema`(스키마 버전), `repoRoot`, `commit`(색인 기준 커밋), `worktree`(색인할 때의 작업 트리 지문), `indexedAt` |
| `files` | `id`, `path`, `language`, `role`, `hash` | 파일 노드. `role`은 `app` 또는 `test`, `hash`는 그 파일의 사실 전체의 해시(역할 포함) |
| `symbols` | `id`, `key`, `name`, `qualified_name`, `kind`, `file_id`, `line`, `col`, `end_line`, `end_col`, `body_line`, `body_end_line`, `parent_key`, `confidence`, `source` | 심볼 노드와 정의 위치(0부터). `body_line`~`body_end_line`은 정의 전체(본문 포함, 사실의 `enclosingRange`)의 줄이고, 색인기가 주지 않으면 이름이 적힌 줄이에요 |
| `relations` | `id`, `kind`, `from_file_id`, `from_symbol_key`, `line`, `col`, `end_line`, `end_col`, `to_symbol_key`, `to_path`, `confidence`, `kind_confidence`, `source` | 간선. 대상은 `to_symbol_key`(심볼) 또는 `to_path`(import한 파일의 경로) |

- 모든 간선과 심볼에 신뢰도(`precise`/`inferred`)와 출처(색인기)가 있어요.
- `to_symbol_key`는 저장소 밖 심볼(예: `dart:core`의 `print`)도 가리킬 수 있어요. 그런 심볼은 `symbols`에 없어요.
- 스키마 버전은 `4`예요(#212가 `files.role`, `relations.kind_confidence`를, #222가 `symbols.body_line`, `symbols.body_end_line`을 더했어요).
- 바깥에 보이는 것은 열고 닫기(`open`, `openExisting`, `close`), 넣기(`applyFacts(facts, meta)`), 질의 함수뿐이에요. 스키마를 바꿔도 질의 함수의 답이 같으면 테스트는 그대로 통과해요.
  - `meta()`, `counts()`, `languages()`
  - `findSymbols(query)`: 이름으로 심볼 찾기.
  - `usesOf(key, limit, filter?)`: 사용처와 전체 개수, 역할별 개수(`byRole`). 앱 코드가 먼저, 테스트가 뒤에 와요. 각 항목에 `role`, `kind`, `kindConfidence`. `filter: { roles?: ('app'|'test')[], kinds?: RelationKind[] }`로 고르면 개수도 고른 것만 세요(impact의 테스트 목록은 `roles: ['test']`, trace의 호출만 따라가기는 `kinds: ['call']`).
  - `findFile(path)`: 파일 하나(`path`, `language`, `role`).
  - `extentsIn(path)`: 파일이 정의하는 이름과 정의 전체가 차지하는 줄(`extent`, 1부터, 끝 포함). detect_changes가 바뀐 줄을 이름으로 옮길 때 써요.
  - `definedIn(path)`: 파일이 정의하는 심볼.
  - `importsOf(path)`, `importersOf(path)`: 파일이 가져오는(다시 내보내는) 파일, 파일을 가져오는 파일.
  - `usersOf(path)`: 파일이 정의한 이름을 쓰는 다른 파일과 사용처 수. 이름으로 이어서 barrel을 거친 곳도 나와요.
  - `filePaths()`, `definitions()`(정의 전부와 바로 바깥 심볼 `parentKey`), `referencedKeys()`(사용처가 있는 열쇠): 저장소 전체를 훑는 검사(check)용.
  - `externalRefs()`: 파일마다 가리키는 저장소 밖 심볼의 열쇠(같은 쌍은 한 번). 코드 지도의 "외부 SDK가 닿는 파일"용.
  - `relationSitesIn(path)`: 파일에 적힌 관계(import 빼고)가 시작하는 자리 전부(저장소 밖 심볼로 가는 것 포함). rename이 색인이 이미 무엇인가로 이은 자리를 `unlinked` 찾기에서 빼요.
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
| `repo`, `db`, `commit`, `adapters`, `dbBytes` | 저장소, 색인 파일, 기준 커밋, 사실을 낸 색인기(정밀 어댑터 이름, 추정 층 `tree-sitter-<언어>`), 색인 파일 크기 |
| `fallbacks` | 정밀 색인기가 없거나(`reason: 'missing'`) 실패해서(`'failed'`, `error`) 추정 층으로 색인한 언어. 칸은 `language`, `indexer`, `reason`, `install`(설치 명령), `inferredBy`(대신 색인한 추정 층, 추정 규칙이 없는 언어면 `null`). 같은 안내가 stderr에도 나와요 |

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

모듈은 "파일 경로 → 모듈 이름"이에요. check(흐름, 층), impact(모듈별 묶음), clusters(여러 모듈에 걸침)가 모두 같은 함수를 써요. 저장소 설정의 `flows`는 실행 흐름(flows)의 진입점이에요.

- `src/repo-config.ts`: `loadRepoConfig(repoRoot, explicitPath?)`가 저장소 뿌리의 `.code-atlas.json`(명령줄 `--config`, MCP `config` 인자로 다른 파일)을 읽어 `RepoConfig`를 돌려줘요. 파일이 없으면 기본 설정(뿌리 바로 아래 폴더 하나가 모듈 하나)이에요. `readAllowlist(repoRoot, source)`는 허용 목록 하나의 대상 파일을 읽어요.
- `src/modules.ts`: `moduleResolver(config)`가 `(path) => 모듈 이름 | null` 함수(`ModuleOf`)를 만들어요. `null`은 어느 규칙에도 맞지 않는 파일(검사 밖)이에요. 질의는 `repoModules(store, configPath)`(설정 읽기 + `moduleResolver`)를 써요. `globToRegExp`, `nameGlobToRegExp`도 여기 있어요.
- 설정 파일을 고르는 질의 인자는 `CONFIG_PARAM`(`src/repo-config.ts`) 하나를 check, impact, clusters, flows가 같이 써요.

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
  "unused": { "private": "_*", "ignore": ["main"] }, // 비공개 이름 모양, 일부러 뺄 이름(진입점 등)
  "map": {                       // 코드 지도 화면(map 명령)만 쓰는 칸. 검사 결과는 바꾸지 않음
    "title": "우리 앱 코드 지도",                       // 없으면 "<저장소 폴더 이름> 코드 지도"
    "bands": { "shared": "모두가 쓰는 도우미" },        // 넓은 띠로 그릴 모듈과 메모. 없으면 shared에서 composers를 뺀 모듈
    "packages": { "http": "HTTP" },                    // 외부 SDK 표에 올릴 패키지와 보일 이름. 없으면 밖 패키지 전부
    "reviewNotes": [{ "modules": ["models"], "label": "데이터 타입", "note": "…" }], // 리뷰 후보의 꼬리표·메모(없으면 helper)
    "select": "orders"                                 // 처음 골라 둘 모듈. 없으면 흐름을 거스르는 import가 닿는 첫 모듈
  },
  "flows": {                     // 실행 흐름(flows)의 진입점
    "entries": [{ "name": "*Page.build" }, { "kinds": ["function"], "name": "main" }], // qualifiedName에 맞추는 glob. 불리는 이름이어도 진입점
    "uncalled": true                                    // 불리지 않는 이름(과 밖에서 불리지 않는 순환)도 진입점으로(기본 true)
  }
}
```

hijo_app의 설정 예는 `test/hijo_app/code-atlas.json`이에요(허용 목록을 `import_boundaries_test.dart`의 `commonMayImport`에서 읽어요).

## 질의: check

`src/query/check.ts`. 저장소 설정으로 검사 안 파일(모듈 규칙에 맞는 파일)을 고르고, 그 사이의 import(`importsOf`), 정의(`definitions`), 쓰인 열쇠(`referencedKeys`)로 답해요.

- `cycles`: 검사 안 파일의 강연결 요소(Tarjan) 가운데 둘 이상인 것. 큰 것부터, 같으면 첫 파일 이름순.
- `modules`: 모듈 그래프(간선 무게 = 모듈 사이 import 수)의 강연결 요소를 위상 순서로 세우고, 서로 도는 묶음 안에서는 흐름을 거스르는 import 수가 가장 적은 순서를 부분집합 DP로 찾아요(묶음이 22개를 넘으면 받은 순서로 두고 `summary.minimal: false`). 위가 가져다 쓰는 쪽이에요. 층(`layer`)은 흐름을 거스르는 간선을 뺀 뒤 맨 아래에서의 가장 긴 거리예요.
- `backwardImports`: 그 순서에서 아래 모듈이 위 모듈을 가져다 쓰는 import. 허용은 (가져다 쓰는 쪽, 대상) 쌍이에요: 가져다 쓰는 파일이나 그 모듈이 허용 목록의 `from`에 맞고 대상이 그 목록에 있으면 `allowed: true`, 아니면 새 위반이에요. 다른 모듈이 같은 대상을 거꾸로 가져오면 새 위반이에요.
- `reviewCandidates`: 다른 모듈의 파일을 가져다 쓰되, 대상 모듈이 `shared`가 아니고, 가져다 쓰는 쪽이 `composers`가 아니고, 대상 파일이 `openToOtherModules`(파일 glob, 또는 그 파일이 정의한 심볼의 이름·종류)에 맞지 않는 것. 판정이 아니라 리뷰 후보예요.
- `unusedPublicNames`: 검사 안 파일의 최상위 선언 가운데, 이름이 `unused.private`에 맞지 않고, 그것과 그 안의 것(생성자, 멤버) 어느 것도 어디서도(테스트 포함) 쓰이지 않은 것. 멤버 하나하나는 보지 않아요: 프레임워크가 부르는 재정의(`build` 등)를 아직 가려내지 못해요. 쓰인 열쇠에서 정의의 바깥 심볼(`parentKey`) 사슬을 따라 올라가며(`ancestry`, "그래프 탐색") 모두 쓰인 것으로 쳐요. 열쇠 문법(`#` 등)은 풀지 않아요. 이름 없는 생성자는 어댑터가 이미 클래스 열쇠로 합쳐요.
- 목록(`cycles`, `backwardImports`, `reviewCandidates`, `unusedPublicNames`)은 `Page`예요(`limit`). 묶음 안의 `files`·`imports`도 같은 `limit`으로 잘리는 안쪽 목록(`InnerList`, 모양은 `Page`와 같음)이에요. 항목의 `confidence`는 그 항목을 이룬 import 가운데 가장 낮은 것, `source`는 낸 색인기들이에요. `modules`는 모듈 수만큼이라 자르지 않아요. `summary`에 각 개수와 허용(`allowed`)·새 위반(`new`) 수가 있어요.

hijo_app 7ba0197로 맞춰 보기: `HIJO_APP_REPO=<hijo_app 저장소> npm run verify:hijo`(`test/hijo_app/`). 무거워서 기본 `npm test`에는 넣지 않았어요.

## 질의: impact

`src/query/impact.ts`. 이름이나 파일을 바꾸면 영향 받는 곳이에요. 그래프를 올려(`Graph.load`) 출발점에서 `graph.reach(starts, 'in', depth)`로 쓰는 쪽을 거슬러 올라가요.

- 출발점: 물은 글이 색인된 파일 경로면 `graph.fileNodes(path)`(파일과 그 파일이 정의한 이름). 아니면 context와 같은 해석기(`resolvePoint`, "지점 풀기")로 찾고, 여럿이면 `ambiguous`와 후보, 없으면 `not_found`. 찾은 심볼에 그 안에 정의된 것(멤버, 생성자: `graph.members`)을 더해요. 클래스를 바꾸면 멤버를 쓰는 곳도 영향 받으니까요.
- 영향 받는 곳(`affected`, `Page`): 도착점마다 하나. 사용처를 감싸는 심볼이고, 파일 최상위에서 쓰면(import 등) 그 파일(`kind: 'file'`)이에요. 칸은 `distance`(직접 쓰면 1), `module`(저장소 설정의 모듈, 규칙 밖이면 `null`), `role`, 심볼이면 `line`·`uses`(사용처 수)·`hot`, 그리고 `via`(바꾼 쪽으로 한 단계 다가가며 쓰는 것의 이름, 관계 종류, 적힌 자리). `confidence`는 reach가 준 길의 신뢰도(길에 추정 관계가 하나라도 있으면 `inferred`), `source`는 `via` 관계를 낸 색인기예요. 순서는 거리, 경로, 줄(파일 노드가 먼저), 이름.
- `modules`: 모듈별 묶음(`affected`, 가장 가까운 거리 `nearest`, 그 가운데 테스트 `tests`). 가까운 모듈부터, 같으면 많은 것, 이름 순, 모듈 밖(`null`)은 뒤. 모듈 수만큼이라 자르지 않아요.
- `tests`(`Page`): 영향 받는 곳이 든 테스트 파일(`role: 'test'`)과 가장 가까운 거리. `confidence`·`source`는 모든 질의와 같은 규칙(`sourcedOf`)이라 그 파일의 항목 가운데 가장 낮은 믿음(하나라도 추정이면 `inferred`)과 출처 모두예요.
- `summary`: `depth`, `affected`, 거리별 개수 `byDistance`, `moreBeyondDepth`(depth 다음 단계에도 닿는 곳이 있는지: reach를 한 단계 더 돌려 봐요), 모듈 수, 테스트 파일 수, 이번 hot 기준 `hotUses`.
- 모듈은 check와 같은 `repoModules(store, config)`예요(`--config`, MCP `config`).

**많이 쓰이는 이름(hot)의 기준:** `GraphStore.useCounts()`의 사용처 수(어느 종류의 관계든, 테스트 포함, 같은 줄에 여러 번이면 여러 번)가 **20 이상**이면 `hot: true`예요(`DEFAULT_HOT_USES`). 인자 `hot`으로 저장소마다 바꿔요. 물은 심볼은 `target.uses`·`target.hot`, 파일을 물으면 `target.hotNames`(그 파일이 정의한 hot 이름)로 나와요. 20은 "한 화면에 다 못 보는 정도"로 잡은 값이에요. 이름을 바꿀 때 손으로 고치기 힘들고 리뷰가 커지는 경계예요.

출발점에서 영향 받는 곳을 찾는 탐색은 `reachImpact(scope, starts)` 하나예요. detect_changes도 바뀐 이름마다 이것을 불러요.

## 질의: detect_changes

`src/query/detect-changes.ts`. 작업 트리의 diff(또는 두 커밋 사이)가 건드린 이름과 그 영향, 이 변경으로 생긴 구조 문제예요. 인자 `base`(기본 `HEAD`)와 `head`(없으면 작업 트리)가 비교할 두 쪽이에요.

- **바뀐 줄** (`src/diff.ts`): `git diff -U0 -M`. 작업 트리를 볼 때는 git 색인의 사본(임시 파일, `GIT_INDEX_FILE`)에 작업 트리 전부를 담아(`git add -A`) base와 비교해요. 그래서 추적하지 않는 새 파일도 보고, 옮긴 파일도 알아보고, 사용자의 staging은 그대로예요(새 파일의 blob이 `.git/objects`에 남을 수 있어요). 이진 파일, 빈 파일, 권한만 바뀐 파일은 이름 바꾸기가 아니면 빠져요.
- **두 그래프**: 바꾸기 전은 base 커밋의 색인, 바꾼 뒤는 `head`가 없으면 저장소 색인(낡았으면 먼저 다시 색인하고 `reindexed: true`), 있으면 그 커밋의 색인이에요. 바뀐 것이 없으면 base를 색인하지 않아요.
- **커밋 색인** (`src/snapshot.ts`): 저장소 색인 옆 `<색인>@<커밋 앞 12자>.db`. 임시 폴더에 로컬 복제(`git clone --shared --no-checkout`, 네트워크 없음)를 만들어 그 커밋을 꺼내고 `indexRepo`로 색인한 뒤 지워요. 커밋은 바뀌지 않으니 한 번 만들면 계속 써요(스키마가 다르면 다시 만들어요). git이 무시해 커밋에 없는 도구 상태 파일은 지금 작업 트리의 같은 자리에서 빌려 와요. 어느 파일인지는 어댑터가 알려 줘요(`toolState`): Dart는 패키지마다 `.dart_tool/package_config.json`과 `package_graph.json`, Python은 없음(scip-python에 빈 환경을 줘요), JavaScript/TypeScript는 없음(`node_modules`는 저장소 밖 패키지의 타입이라 빌리지 않아요. 그래서 커밋 색인에서는 그 패키지에서 온 값의 멤버와, `node_modules` 링크로만 풀리는 작업 공간 패키지 import를 잇지 못할 수 있어요). 빌린 설정이 그 커밋에 맞는지는 `sameAs`(Dart: 그 패키지의 `pubspec.yaml`과 `pubspec.lock`)로 가려요. 하나라도 커밋과 작업 트리에서 다르면(git 개체 id로 견줘요: `rev-parse <커밋>:<경로>`와 `hash-object`. git이 무시하는 파일은 없는 것으로 쳐요) 빌리기는 하되 그 색인기가 낸 심볼과 관계를 `confidence: inferred`(`kindConfidence`도)로 낮춰 넣어요(`indexRepo`의 `untrusted`, `source`는 그대로 `scip-dart`). 그래서 그 커밋 색인에서 온 항목(지운 이름과 그 영향 등)은 답에 추정으로 나와요. 맞지 않을 수 있는 설정으로 만든 결과를 정밀이라 하지 않으려는 거예요. 빌리지 않고 추정 층으로 색인하지 않는 것은 열쇠 때문이에요: 추정 층의 열쇠는 정밀 열쇠와 달라서 바꾸기 전과 바꾼 뒤의 이름을 짝짓지 못하고 고친 이름마다 `added`·`removed`가 함께 나와요. 낮춘 색인은 따로 둬요(`<색인>@<커밋>-unsure.db`): 잠금 파일이 같아지면 다시 정밀 색인을 만들어 써요.
- **줄 → 이름**: 바꾸기 전 줄(지우거나 고친 줄)은 바꾸기 전 그래프의 이름에, 바꾼 뒤 줄(더하거나 고친 줄)은 바꾼 뒤 그래프의 이름에 옮겨요. 줄마다 그 줄을 품는 가장 안쪽 이름(`extentsIn`의 정의 전체 범위)이 건드린 이름이에요. 그래서 메서드 하나를 고치면 클래스가 아니라 그 메서드가 나오고, 위에 줄을 더해 자리만 밀린 이름은 나오지 않아요. 이름 밖의 줄(import, 파일 머리 주석)은 이름으로 옮기지 않아요(import가 바뀌어 생긴 구조 문제는 아래 구조에서 봐요).
- **바뀜(`change`)**: 같은 경로의 이름은 열쇠로 짝지어요. 바꾼 뒤에만 있으면 `added`, 바꾸기 전에만 있으면 `removed`, 양쪽에 있고 어느 쪽이든 건드렸으면 `modified`. 옮긴 파일은 열쇠에 경로가 들어 있어 달라지니 바깥 타입을 붙인 이름과 종류로 짝짓고, 건드리지 않았으면 `moved`, 건드렸으면 `modified`이고 둘 다 `movedFrom`(옮기기 전 경로)이 붙어요. 파일 자체가 생기거나 지워지거나 옮겨졌으면 그 파일도 항목 하나(`kind: 'file'`, `confidence: 'precise'`, `source: 'git'`: git이 알려 준 사실이라서요)예요. 색인하지 않는 파일(문서 등)은 빠져요.
- **영향**: 바뀐 것마다 impact와 같은 탐색(`reachImpact`, 이름은 멤버와 함께 출발, 파일은 파일 노드만). 지운 이름은 바꾸기 전 그래프에서(그것을 쓰던 곳), 나머지는 바꾼 뒤 그래프에서 찾아요. 바뀐 항목의 `impact`는 요약(`affected`, `byDistance`, `moreBeyondDepth`, `tests`)이고, 항목은 답의 `affected`(`Page`)에 모두 합쳐 나와요: 같은 곳(경로, 종류, 이름)은 가장 가까운 거리로 하나, `from`은 닿은 바뀐 이름들, `changed`는 그곳도 이 변경이 건드렸는지(바뀐 이름이거나, 파일이면 diff에 든 파일)예요. `changed: false`인 곳이 고치지 않은 채 남은 영향이에요.
- **모듈과 테스트**: `modules`는 모듈마다 바뀐 것(`changed`), 영향 받는 곳(`affected`), 그 가운데 테스트(`tests`) 수. 바뀐 것이 많은 모듈부터, 같으면 영향이 많은 것, 모듈 밖(`null`)은 뒤, 이름 순. `tests`(`Page`)는 고친 테스트 파일(거리 0, 지운 것 빼고)과 영향 범위에 걸린 테스트 파일이에요.
- **구조**: 양쪽에 check를 돌려(규칙은 둘 다 지금 저장소의 설정: `check`·`repoModules`의 `root` 인자) 비교해요. 옮긴 파일은 바꾸기 전 경로를 바꾼 뒤 경로로 맞춰요.
  - 순환(`structure.cycles`): 바꾼 뒤의 묶음이 바꾸기 전에도 똑같이 있었으면 `existing`(개수만), 겹치는 묶음이 있었으면 `status: 'changed'`, 없었으면 `'new'`로 `introduced`(`Page`)에 나와요. `resolved`는 바꾼 뒤 어느 묶음과도 겹치지 않는 바꾸기 전 묶음의 수예요.
  - 경계 위반(`structure.violations`): 흐름을 거스르는 import 가운데 허용 목록에 없는 것(check의 새 위반). (가져다 쓰는 파일, 대상)이 바꾸기 전에도 위반이었으면 `existing`, 아니면 `introduced`예요. `newImport`는 그 import 자체가 이 변경으로 생겼는지예요. `false`면 이미 있던 import가, 새 import 때문에 모듈 순서(흐름을 거스르는 수가 가장 적은 순서)가 바뀌며 위반이 된 거예요.
- 줄 범위를 쓰려고 그래프 저장소에 정의 전체의 줄(`body_line`, `body_end_line`)을 둬요(스키마 4).
- 질의 실행기는 이 질의 때문에 `run`이 Promise를 돌려줄 수 있고 색인 파일 자리(`ctx.db`)를 받아요(`src/queries.ts`).
- **봉투**: 답을 만든 색인을 `ctx.describeIndex`로 알려요. `--head`면 head 커밋의 색인(`stale: false`), 아니면 저장소 색인이고, 둘 다 `base`(바꾸기 전 커밋과 그 색인을 만든 때)를 더해요(docs/contract.md 약속 1).

## 질의: clusters

`src/query/clusters.ts`. 서로 촘촘히 엮인 이름들의 묶음이에요. 폴더 구조(모듈)와 실제 결합이 어긋난 곳을 찾는 데 써요. 정답이 하나인 문제가 아니라서, 예제 저장소(`test/fixtures/cluster_sample`)는 두 덩어리가 뚜렷한 작은 저장소로 잡았어요.

- **그래프**: `Graph.load(store)`의 노드(`allNodes`)와 나가는 간선(`out`)에서 만들어요. 노드는 앱 코드(`role: 'app'`)의 최상위 선언이에요. 멤버(메서드, 필드, 생성자)는 바깥 타입으로 접고, 이름 공간과 테스트 코드, 파일 노드(import 간선)는 빼요. 간선은 방향을 지운 무게 있는 간선이고, 무게는 두 선언 사이의 관계 수(종류 무관)예요. 한 선언 안의 관계(자기 고리)는 셈하지 않아요.
- **알고리즘: Louvain 방법**(모듈성 최대화). V. D. Blondel, J.-L. Guillaume, R. Lambiotte, E. Lefebvre, "Fast unfolding of communities in large networks", *J. Stat. Mech.* (2008) P10008. 라이브러리 없이 직접 구현했어요(들인 부품이 없어 라이선스 걱정이 없어요). 해상도(γ)는 1이에요.
  - 1단계(노드 옮기기)는 노드를 id 순으로 훑고, 모듈성 증가량이 가장 큰 이웃 묶음으로 옮겨요. 같으면 번호가 작은 묶음, 제자리보다 크지 않으면 그대로예요. 2단계는 묶음을 노드 하나로 접어요. 더 옮길 것이 없을 때까지 되풀이해요.
  - 난수를 쓰지 않아서 같은 색인이면 늘 같은 묶음이 나와요.
  - Louvain은 이어지지 않은 묶음을 낼 수 있어요(V. A. Traag, L. Waltman, N. J. van Eck, "From Louvain to Leiden: guaranteeing well-connected communities", *Sci. Rep.* 9, 5233 (2019)). 그래서 마지막에 묶음마다 이어진 조각으로 나눠요. Leiden의 다듬기 단계는 하지 않았어요.
- **답**: `clusters`(`Page`)는 둘 이상이 든 묶음이에요. 큰 것부터, 같으면 대표 이름순. 항목마다 `size`, `representative`(묶음 안 이름과 엮인 무게가 가장 큰 선언, 같으면 id 순: 이름·종류·정의 위치), `names`(이름순), `files`(경로순), `modules`(`repoModules`로 구한 모듈, 어느 모듈에도 안 든 파일은 빠짐), `crossModule`(모듈이 둘 이상), `internalEdges`/`externalEdges`(묶음 안/밖과의 관계 수), `confidence`(묶음 안 관계 가운데 가장 낮은 것), `source`. `names`와 `files`는 check의 `cycles.files`처럼 같은 `limit`으로 잘리는 안쪽 목록(`InnerList`)이고, `size`가 이름 수예요.
- `summary`: 셈한 이름 수(`names`), 묶음 수(`clusters`), 혼자 남은 이름 수(`singletons`, 목록에 안 나옴), 여러 모듈에 걸친 묶음 수(`crossModule`), 나눈 결과의 모듈성(`modularity`, 소수 셋째 자리).
- 모듈 기준은 check와 같은 저장소 설정이에요(`--config`, MCP `config`).
- 묶음 계산(`computeClusters`)은 자르기 전 묶음 전부를 내요. clusters 답과 flows의 "이 이름이 든 묶음"(`clustersOf`: 이름의 최상위 선언이 든 묶음)이 이것을 같이 써서, 두 답의 묶음이 늘 같아요.

## 질의: flows

`src/query/flows.ts`. 진입점에서 시작하는 실행 흐름이에요. 낯선 기능의 큰 줄기를 파악하고, 이름 하나가 어느 묶음과 어느 흐름에 속하는지(변경이 어떤 사용자 경로에 닿는지) 답해요. 정답이 하나인 문제가 아니라서, 예제 저장소(`test/fixtures/flow_sample`)는 흐름이 뚜렷한 작은 저장소로 잡았어요.

- **그래프**: `Graph.load(store, { kinds: ['call', 'read'] })`에서 코드를 돌리는 관계만 따라가요. 부름(`call`)은 모두, 읽기(`read`)는 읽으면 코드가 도는 것만이에요: getter(본문)와 모듈 수준 변수(`kind: variable`이고 바깥 심볼이 없는 것. 초기화 식에서 부르는 것은 그 변수가 부른 것으로 잡혀요. Dart 최상위 변수는 처음 읽을 때 초기화되고, Riverpod provider도 이렇게 읽혀요). 필드·상수 읽기와 타입 참조, import는 따라가지 않아요. 노드는 앱 코드(`role: 'app'`)의 심볼(이름 공간 빼고)이고, 테스트 코드가 부르는 것은 셈하지 않아요. 두 이름 사이 관계가 여럿이면 대표 하나(정밀한 것, 종류가 정밀한 것, 적힌 자리 순)예요.
- **진입점** (`reasons`):
  - `uncalled`: 앱 코드 어디서도(파일 최상위 포함) 부르거나 읽어 돌리지 않으면서, 앱 코드의 이름을 하나라도 부르는 이름. Flutter의 `build`처럼 프레임워크가 부르는 것, 값으로 넘겨지는 콜백, 쓰이지 않는 코드가 여기 들어요.
  - `cycle`: 서로만 부르는 순환(강연결 요소 둘 이상, check의 `stronglyConnected`) 가운데 밖에서 부르는 곳이 없는 것. 노드 id가 가장 작은 이름 하나가 진입점이에요. 이게 없으면 그런 순환은 어느 흐름에도 안 나와요.
  - `config`: 저장소 설정 `flows.entries`(이름 glob을 `qualifiedName`에, `kinds`를 종류에 맞춤)에 맞는 이름. 코드 안에서 불려도 진입점이에요. 맞는 이름이 없는 glob은 `summary.unmatched`에 나와요. `flows.uncalled: false`면 앞의 둘은 셈하지 않아요.
- **흐름 하나**: 진입점에서 깊이 우선(앞 순회)으로 따라가요. 한 이름이 부르는 것들은 관계가 적힌 자리(경로, 줄, 열) 순이라, 거치는 이름의 순서가 대략 실행 순서예요(분기·반복·비동기는 보지 않아요). 흐름 안에서 이미 나온 이름은 다시 펼치지 않아요(같은 이름을 두 번 적지 않고, 순환도 여기서 끊겨요). `depth`(기본 10)까지만 따라가고, 그 끝의 이름이 흐름에 없는 이름을 더 부르면 `beyondDepth: true`예요.
- 클래스를 만들면(`Cart()`) 클래스에 닿지만 그 멤버로 들어가지 않아요(trace와 같아요). 인터페이스 메서드를 부르는 곳은 구현으로 이어지지 않아서, 구현 메서드는 불리지 않는 진입점으로 나올 수 있어요.
- **답**: `query`(물은 이름 또는 `null`), `config`, `depth`, `length`, `summary`(`entries`, `uncalled`, `cycles`, `configured`, `unmatched`: 거르기 전 전체), `flows`(`Page`, `limit`). 흐름은 큰 것(`size`)부터, 같으면 진입점 이름, 열쇠 순이에요.
  - 흐름 하나: `entry`(지점), `reasons`, `size`(진입점 포함 이름 수), `steps`(`Page`, 진입점 다음부터 `length`개, 기본 30), `beyondDepth`, 그리고 구간 가운데 가장 낮은 `confidence`·`kindConfidence`와 출처 모두(`source`). 구간이 없으면(설정한 진입점이 아무것도 안 부르면) 진입점의 표시예요.
  - 구간(`steps`의 항목): 이름의 지점(`name`, `kind`, `path`, `line`, `column`, `key`), `depth`(진입점이 부르면 1), `from`(부른 이름), `relation`(`call`/`read`), `at`(적힌 자리), 그 관계의 `confidence`·`kindConfidence`·`source`. 추정 층이 낸 관계를 지나는 구간은 `confidence: inferred`예요(trace의 "추정 관계의 표시"와 같은 규칙).
- **이름을 물으면** (`flows <이름>`): `resolvePoint`로 풀어요(여럿이면 `ambiguous`와 `candidates`, 없으면 `not_found`). 찾으면 `status: 'found'`, `target`(지점), `clusters`(`Page`: 그 이름의 최상위 선언이 든 묶음. 혼자 남은 이름이면 빈 목록), 그리고 그 이름(과 그 멤버, 파일이면 그 파일이 정의한 이름)을 거치는 흐름만이에요. 흐름마다 `hits`(흐름에서 맞은 이름, 흐름 순)가 붙어요. 거치는지는 `depth` 안에서 봐요(`length`로 잘린 구간도 셈해요).

## 그래프 탐색

`src/graph/traverse.ts`. impact, trace, clusters, flows가 함께 써요. 질의마다 탐색을 따로 만들지 않아요.

- `GraphStore.edges({ kinds? })`: 관계 하나가 간선 하나(`EdgeRow`). 출발은 사용처를 감싸는 심볼(파일 최상위면 그 파일), 도착은 저장소 안의 심볼 또는 파일(import). 저장소 밖 심볼을 가리키는 관계는 빠져요.
- `Graph.load(store, { kinds? })`: 간선과 정의를 메모리의 인접 목록으로 올려요. 노드 id는 심볼 `s:<열쇠>`, 파일 `f:<경로>`(`nodeId`).
  - 매개변수는 노드가 아니에요(정의 목록에 없어요). 그런데 색인기는 매개변수 기본값 안의 사용처(`{int extra = baseFee}`)를 그 매개변수가 감싼 것으로 적고, 이름 있는 인자는 매개변수를 가리켜요. 그래서 간선의 끝이 매개변수면 그 매개변수가 적힌 자리를 감싸는 가장 안쪽 정의(함수, 생성자 등)로 옮겨 붙여요(`GraphStore.parameterOwners()`. scip-dart가 매개변수의 바깥 심볼을 주지 않아서 정의가 차지하는 줄 `extentsIn`으로 찾아요). 감싸는 정의가 없으면 출발은 그 파일, 도착이면 간선을 빼요. 전에는 이런 간선을 따라간 impact가 오류로 멈췄어요(hijo_app 이름의 3분의 1).
- `graph.in(id)` / `graph.out(id)`: 이 노드를 쓰는 간선 / 이 노드가 쓰는 간선. `graph.node(id)`는 이름, 정의 파일, 역할(app/test), 정의(`DefinitionRow`)를 줘요. `graph.fileNodes(path)`는 파일과 그 파일이 정의한 심볼의 노드예요.
- `graph.reach(starts, 'in' | 'out', maxDepth)`: 너비 우선으로 거리별 도착점(`Reached`)을 줘요. 같은 거리라면 정밀한 길을 먼저 골라요. 길에 추정 관계가 하나라도 있으면 그 도착점은 `inferred`예요. 결과 순서는 거리, 그 안에서 id 순이라 다시 돌려도 같아요.
- `graph.members(id)`: 그 노드와 그 안에 정의된 심볼(멤버, 멤버의 멤버 …). 이름 하나를 출발점·도착점으로 삼을 때 써요(impact, trace).
- `ancestry(key, parentOf)`: 열쇠에서 바깥 심볼(`parentKey`) 사슬을 따라 올라간 열쇠들(자기 자신이 먼저). 부모 사슬을 오르는 곳은 모두 이것을 써요. `graph.topLevel(id)`(clusters: 노드를 감싸는 최상위 선언)와 check의 쓰인 이름이에요.
- `graph.paths(starts, targets, { maxDepth, cap })`: 출발점들에서 도착점들까지 out 방향의 단순 경로(같은 노드를 두 번 지나지 않음)를 길이 순으로 찾아요. 같은 길이면 지나는 노드 id의 사전 순이에요(길이별로 깊이 우선을 id 순으로 돌아 찾는 순서가 곧 답의 순서라 다시 돌려도 같아요). 경로는 도착점에 처음 닿는 곳에서 끝나고 중간에 다른 출발점을 지나지 않아요. 두 노드 사이 간선이 여럿이면 대표 하나(정밀한 관계, 종류가 정밀한 관계, 적힌 자리 순)만 써요. 도착점까지 남은 거리(`reach(targets, 'in')`)로 가지를 치고, `cap`개를 찾으면 멈춰 `capped: true`를 줘요.
- 사용처 수는 `GraphStore.useCounts()`(심볼 열쇠 → 수). "많이 쓰이는 이름"(impact, 기준은 "질의: impact")과 검색 정렬(search)이 이 수를 써요.
- 모듈은 `src/modules.ts`의 `repoModules(store, config)`로 노드의 `path`에서 얻어요.

## 지점 풀기와 서술

`src/query/point.ts`. context, impact, trace, rename이 같은 것을 써요.

- `resolvePoint(store, query)`: 물은 글이 색인된 파일 경로와 정확히 맞으면(`\`는 `/`로) `file`, 아니면 이름(`findSymbols`: key → qualifiedName → name)으로 `symbol`, 여럿이면 `ambiguous`(후보), 없으면 `not_found`.
- `Point`와 `pointOfSymbol`, `pointOfFile`, `pointOfNode`: 답에 지점을 적는 꼴(`name`, `kind`, `path`, 심볼이면 `line`, `column`, `key`, `confidence`, `source`). trace의 지점과 impact의 항목, clusters의 대표 이름, flows의 진입점과 구간이 이것으로 적혀요. `locationOf`는 적힌 자리에서 경로·줄·열만 남겨요.

## 질의: trace

`src/query/trace.ts`. 두 지점 사이 경로(`trace <from> --to <to>`). "이 버튼이 어떻게 저 함수까지 가나"에 답해요.

- 지점: 물은 글이 색인된 파일 경로면 그 파일 노드와 그 파일이 정의한 심볼 전부(`fileNodes`), 아니면 context와 같은 해석기(`resolvePoint`)로 찾은 심볼 하나와 그 멤버 전부(`members`)예요. 클래스를 주면 그 메서드 안의 호출에서 출발하고, 클래스를 도착점으로 주면 그 멤버에 닿아도 도착이에요. 도착점에 든 노드는 출발점에서 빼요(둘이 같으면 오류).
- 중간에 클래스에 닿아도 그 멤버로 들어가지 않아요. 만들기만 해서 메서드가 불린다고 보지 않아요(Flutter의 `build`처럼 프레임워크가 부르는 길은 아직 안 나와요).
- `follow`: `calls`(기본)는 `Graph.load(store, { kinds: ['call'] })`, `all`은 모든 종류(참조, 읽기, 쓰기, 상속, 구현, import)로 그래프를 올려요.
- `depth`(기본 10): 경로의 가장 긴 길이(구간 수). `limit`: 경로를 앞에서부터 몇 개 줄지. 경로는 `graph.paths`로 찾고 상한 `PATH_CAP`(1000)에서 세기를 멈춰요. 멈췄으면 `paths.capped: true`이고 `total`은 그때까지 센 수(실제는 더 많음)예요.
- 순서: 짧은 것부터, 같은 길이면 지나는 노드 id 순(파일 `f:`가 심볼 `s:`보다 앞). 같은 질문은 늘 같은 답이에요.
- 답: `query`(`from`, `to`), `follow`, `depth`, `status`, `from`·`to`(지점: `name`, `kind`, `path`, 심볼이면 `line`, `column`, `key`, `confidence`, `source`. 파일 지점에는 표시가 없어요: 계약의 예외), `paths`(`Page` + `capped`).
  - 경로 하나: `length`, `nodes`(지나는 지점), `steps`(구간: `from`, `to`, `kind`, `at` 적힌 자리, `confidence`, `kindConfidence`, `source`), 그리고 경로 전체의 `confidence`·`kindConfidence`·`source`.
- 상태: `found`, `no_path`(`paths`는 빈 목록, `reverse`: to에서 from으로는 이어지는지, `shortestBeyondDepth`: depth 밖에 경로가 있으면 그 가장 짧은 길이), `ambiguous`(`candidates.from`/`candidates.to`: 여럿에 맞은 쪽만), `not_found`(`notFound`: `['from']`, `['to']` 또는 둘 다). 찾지 못한 쪽이 있으면 모호한 쪽보다 먼저 알려요.

### 추정 관계의 표시

구간마다 두 믿음이 따로 붙어요. 경로의 `confidence`·`kindConfidence`는 구간 가운데 가장 낮은 것이라, 경로 하나만 보고도 추정을 거쳤는지 알아요.

- `confidence`: 그 관계가 있다는 것(어디서 무엇을 쓰는지)의 믿음. 정밀 어댑터(scip-dart)의 관계는 `precise`, 추정 층(Tree-sitter)의 관계는 `inferred`예요. `inferred` 구간은 이름으로 이은 것이라 다른 같은 이름일 수 있어요.
- `kindConfidence`: 그 관계의 종류(`kind`)의 믿음. Dart에서 `call`·`read`·`write`·`reference`는 문법으로 가려 `inferred`, `import`와 상속·구현은 `precise`예요. 그래서 Dart의 `follow: calls` 경로는 늘 `kindConfidence: inferred`예요: 관계는 정밀하지만, 그것이 "호출"이라는 것은 문법으로 가린 추정이에요(예: 함수를 값으로 넘기는 곳은 `read`로 가려져 호출 경로에서 빠져요).

## 질의: rename

`src/query/rename.ts`. 이름 하나를 새 이름으로 바꿀 때 고칠 자리 전부의 계획(`rename <이름> --to <새 이름>`)이에요. **파일은 고치지 않아요.** 계획대로 고치는 것은 부르는 쪽이에요.

- 이름: context와 같은 해석기(`resolvePoint`). 여럿이면 `ambiguous`와 후보, 없으면 `not_found`. 다만 후보가 모두 같은 파일, 같은 바깥 이름의 getter·setter면 접근자 짝 하나로 보고 함께 바꿔요(추정 층은 getter와 setter를 따로 적어요. 정밀 Dart 어댑터는 이미 한 열쇠로 합쳐요). 파일 경로, 식별자가 아닌 새 이름(점·공백), 지금과 같은 새 이름은 오류(`UserError`)예요.
- **고칠 자리** (`RenameSite`): 한 줄 안의 `[column, endColumn)`(1부터, UTF-16 단위) 글 `oldText`를 `newText`로. `kind`(`definition`, 사용처의 관계 종류, `unlinked`), `role`, 감싸는 이름 `in`, `confidence`, `source`. 경로, 줄, 열 순이에요. 언어마다 모양이 같아요.
  1. 색인이 알려 준 자리: 정의와 사용처 전부(`usesOf`). Dart의 show·hide 조합자, 글에 끼운 이름(`$x`, `${x}`), 이름 있는 생성자 선언의 클래스 이름(`Money.zero`의 `Money`)은 scip-dart가 사용처로 줘서 여기 들어요.
  2. 자리마다 저장소 파일의 그 자리 글이 옛 이름인지 확인해요. 다르면 계획에 넣지 않고 경고(`mismatch`)예요(색인이 낡았거나 색인기의 범위가 이름과 다를 때).
  3. **색인이 잇지 못한 자리(`unlinked`)**: 정의를 품은 범위(멤버면 바깥 타입의 정의 전체, 아니면 정의 자신) 안에서 옛 이름과 같은 글 가운데, 색인의 정의·관계가 없는 자리를 그 언어의 추정 규칙(`inferredFor(language)`의 `isCodeIdentifier`, `codeIdentifiersAt`)으로 읽어 식별자인 것만 골라요. 주석과 글(문자열) 안은 빼고, 글에 끼운 식(Dart `$x`·`${x}`, JS `${x}`, Python f-string `{x}`) 안은 넣어요. 질의는 문법의 노드 이름을 몰라요. 정밀 Dart 어댑터가 열쇠를 합치며 정의를 하나만 남긴 것(이름 없는 생성자 선언 `Money(…)`, getter와 짝인 setter 선언)이 여기서 나와요. 문법으로 고른 것이라 `confidence: inferred`, `source: tree-sitter-<언어>`예요. 추정 규칙이 없는 언어는 찾지 않아요.
- **셋으로 나눠요**: `edits`는 정밀 층의 자리, `inferred`는 추정 층이 이은 자리, `unlinked`는 색인이 잇지 못해 구문으로만 찾은 자리(위 3)예요. 그래서 `inferred`는 추정 층에서 온 것뿐이에요. 같은 자리가 정밀과 추정 둘 다에서 나오면 정밀을 둬요. 셋 다 `Page`(`limit`)이고, 잘렸으면(`truncated`) 계획이 다 나오지 않은 것이니 늘려서 다시 물어요.
- **경고** (`warnings`, `Page`): 종류 순(`conflict`, `override`, `mismatch`), 그다음 경로·줄·열 순. 항목의 표시는 그 경고가 가리키는 정의의 것이에요.
  - `conflict`(새 이름이 같은 범위의 다른 이름과 겹침): 멤버면 같은 타입과, 상속·구현(`extends`/`implements` 간선을 위아래로 따라간 타입)으로 이어진 타입의 멤버. 최상위 이름이면 고칠 파일에 정의된 최상위 이름, 그리고 고칠 파일이 이미 쓰는 다른 파일의 최상위 이름.
  - `override`: 상속·구현으로 이어진 타입에 옛 이름과 같은 멤버가 있어요. 함께 바꾸지 않으면 재정의 관계가 끊겨요(바꾸지는 않아요: 어느 쪽까지 바꿀지는 부르는 쪽이 정해요).
- 답: `query`, `newName`, `status`, `oldName`, `targets`(바꿀 심볼), `edits`, `inferred`, `unlinked`, `warnings`, `summary`(`files`: 고칠 파일 수, 각 목록의 개수).
- 놓치는 것: 추정 층으로만 색인한 언어는 추정 층이 잇지 못한 사용처(Dart: show·hide, 글에 끼운 함수 값, 수신자 타입을 알아야 하는 멤버)가 계획에 없어요. 지역 이름(매개변수, 지역 변수)은 그래프에 없어 바꿀 수 없어요. 이름 붙은 인자(`f(amount: 1)`)처럼 색인기가 사용처로 주지 않는 자리도 없어요. 저장소 밖에서 쓰는 곳(다른 저장소, 문서)은 모르니 공개 API는 부르는 쪽이 판단해요.
- 시험은 `test/rename.test.ts`: 예제 `rename_sample`(getter·setter 짝, 이름 있는/없는 생성자, show·hide barrel, 글에 끼운 이름, 겹치는 이름, 구현하는 인터페이스)에서 계획을 정답과 비교하고, 물은 뒤 파일이 바이트 단위로 그대로인지, 계획을 저장소 밖 사본에 적용하면 `dart analyze --fatal-infos`를 통과하는지 봐요. 추정 층 목록은 `mixed_sample`과 `CODE_ATLAS_DISABLE_INDEXERS=scip-dart`로 진짜 추정 자리를 만들어 봐요.

## 코드 지도 (map)

`src/map/`. 질의가 아니라 명령 하나(`code-atlas map`)예요. 답이 JSON이 아니라 HTML 파일이라 `QUERIES`에 넣지 않았어요.

- `draw.ts`: `drawCodeMap({ repo, db, config, out })`. 색인이 없거나 낡았으면(`isStale`) `indexRepo`로 먼저 색인하고, 자료를 뽑아 `template.html`의 `code-map-data` 자리(`<script type="application/json">`)에 JSON으로 넣어 써요. `out`이 없으면 색인 파일 옆 `<이름>-map.html`이에요.
- `data.ts`: `codeMapData(store, config)`가 화면 자료(`MapData`)를 만들어요. 구조 계산은 다시 하지 않아요.
  - `check`의 답: 모듈 순서와 층(`modules`), 흐름을 거스르는 import와 허용 표시(`backwardImports`), 서로 물린 파일(`cycles`), 리뷰 후보(`reviewCandidates`), 최소인지(`summary.minimal`).
  - check와 같은 import 집합(`scopedImports`, `src/query/check.ts`): 모듈 사이 import(`medges`), 파일마다 쓰이는 곳·가져다 쓰는 곳 수. 서로 도는 모듈은 check의 `stronglyConnected`로 묶어요.
  - 테스트 열: 테스트 파일(`role: 'test'`)이 직접 import하면 2(`importersOf`), 그 파일이 정의한 이름을 다른 파일(barrel 등)을 거쳐 쓰면 1(`usersOf`), 아니면 0이에요. barrel에 들었어도 테스트가 그 이름을 쓰지 않으면 0이에요(옛 코드 지도는 1이었어요).
  - 외부 SDK: `externalRefs()`의 열쇠 가운데 라이브러리(파일) 자체를 가리키는 것(SCIP 기술자가 모두 namespace)의 패키지 이름(`src/map/packages.ts`). 그 패키지를 import한 파일이에요. 언어 기본 라이브러리(정밀 어댑터의 `isStandardLibrary`: Dart는 `dart:async`처럼 ':'이 든 이름, Python·TS는 아직 가리지 않아요)와 저장소 자신의 패키지는 빼요.
  - 그래프에 없는 둘: 줄 수(작업 트리의 파일, 끝 줄바꿈도 한 줄로 셈)와 최근 90일 변경 횟수(`git log --since="90 days ago" --no-merges`). 브랜치는 그릴 때의 `git rev-parse --abbrev-ref HEAD`, 커밋은 색인 기준 커밋이에요(낡았으면 다시 색인하니 둘이 맞아요).
- `template.html`: 화면. 그리는 것만 해요(띠 모듈 배치, 요약 문장, 표). 파일 표의 줄마다 `id="file=<경로>"`가 있고, 주소의 `#file=<경로>`를 읽어 그 파일을 보여 줘요. 파일 이름은 이름 단위 그래프 화면의 그 파일(`<graph>#file=<경로>`, `MapData.graph`)로 가는 링크예요.
- 시험은 `test/map.test.ts`(예제를 색인하고 `map`을 불러 HTML에 든 자료를 정답과 비교)와 `npm run verify:hijo`(hijo_app 7ba0197에서 옛 코드 지도와 비교)예요. 화면의 생김새는 브라우저로 띄워 확인해요.

### 이름 단위 그래프 화면

`map`이 코드 지도 옆에 `<지도 이름>-graph.html`도 그려요(출력의 `graph`). 이름이나 파일 하나를 골라 정의, 사용처, 영향 범위를 그래프로 보고 이웃을 눌러 따라가요. 밖에서 받는 것이 없어요(라이브러리도 글꼴도 없이 시스템 글꼴과 직접 그린 SVG).

- `graph-data.ts`: `symbolGraphData(store, meta)`가 `GraphData`를 만들어요. 계산은 질의에 맡겨요.
  - 노드 순서는 `search`(조건 없음)의 답 순서(많이 쓰이는 것이 먼저), 그다음 파일(경로 순), 그다음 영향 범위에서 만난 그 밖의 정의예요. 화면의 검색이 이 순서로 보여요.
  - 이름마다 `context`(사용처 `GRAPH_USES_LIMIT`개)와 `impact`(깊이 3, 영향 받는 곳 `GRAPH_AFFECTED_LIMIT`개와 거리별 전체 개수), 파일마다 `context`의 네 목록(정의하는 이름, 가져오는 파일, 가져가는 파일, 쓰는 파일)과 `impact`를 그대로 담아요. 이름 수천 개를 잇달아 물어서 impact에는 그래프와 설정을 한 번만 읽어 넘겨요(`prepareImpact`, `impact(…, prepared)`).
  - 영향 받는 곳마다 한 단계 가까운 노드(via)를 노드 번호로 담아요: 한 거리 가까운 항목 가운데 impact 답의 `via.name`과 이름이 같은 것이고, 거리 1은 고른 것이에요.
  - 정밀/추정과 출처는 답의 항목마다 그대로 담아요. 칸 이름과 튜플의 뜻은 `GraphNode`의 주석에 있어요. hijo_app(이름 4,108개, 파일 329개)에서 HTML 4.3MB, `map` 전체 18초쯤이에요.
- `graph.html`: 화면. 검색은 `search` 질의의 맞춤 규칙(`words`, `matches`)의 소스를 `renderSymbolGraph`가 그대로 넣어 써요(규칙을 화면에 따로 짜지 않아요). 파일은 경로 일부로 찾아요. 그래프는 칸 다섯(정의 → 고른 것 → 거리 1, 2, 3. 칸마다 10개까지 그리고 나머지는 "더" 칸과 아래 목록)이고, 좁은 폭(680px 아래)에서는 칸이 위에서 아래로 쌓여요. 정밀 관계는 실선, 추정 관계는 노란 점선, 정의가 추정인 이름은 노란 점선 테두리예요. 주소는 `#symbol=<열쇠>`나 `#file=<경로>`라 뒤로 가기로 따라온 길을 되짚어요.
- 시험은 `test/graph-view.test.ts`: 예제를 정밀 층과 추정 층(`CODE_ATLAS_DISABLE_INDEXERS=scip-dart`)으로 색인하고, 그래프 자료가 같은 저장소에 명령줄로 물은 search·context·impact의 답과 같은지 봐요.

## 질의 실행기와 바깥 껍데기

```
src/cli.ts ─┐                                  ┌─▶ src/locate.ts   (저장소 → 색인 파일, 없으면 색인 명령 안내)
            ├─▶ src/queries.ts  askQuery(def) ─┼─▶ QueryDef.run   (src/query/*.ts, 몸통만)
src/mcp.ts ─┘   QUERIES, checkArgs             └─▶ src/answer.ts   (봉투 index, page(), formatAnswer)
```

- `src/queries.ts`: 질의 목록 `QUERIES`와 실행기 `askQuery(def, rawArgs, { repo, db? })`. 인자를 `def.params`대로 검사하고(`checkArgs`), 색인을 열고(`openIndex`), `def.run`의 몸통에 봉투를 씌워요(`envelope`).
- `src/answer.ts`: 답의 계약을 지키는 도우미. `IndexInfo`(봉투), `Page`/`InnerList`와 `cut()`·`page()`(잘린 목록), `Sourced`(항목의 `confidence`·`source`)와 `sourcedOf()`·`lowest()`·`joinSources()`(여럿을 묶은 항목의 표시: 가장 낮은 믿음과 출처 모두), `compareText()`(답의 순서를 정하는 코드포인트 비교, 로캘과 무관), `DEFAULT_LIMIT`, `formatAnswer`.
- `src/locate.ts`: `defaultDb(repo)`(저장소마다 `~/.code-atlas/` 아래 파일 하나), `openIndex(target)`, 바깥에 그대로 보일 오류 `UserError`.
- `src/cli.ts`: `index`, `mcp`, 그리고 `QUERIES`의 질의마다 명령 하나. `Param`의 `positional`은 위치 인자, 나머지는 `--이름` 옵션이에요.
- `src/mcp.ts`: 공식 MCP SDK(`McpServer`, stdio). `QUERIES`의 질의마다 도구 하나, 입력 스키마는 `Param`에서 만든 zod에 `repo`를 더한 것. 오류는 `isError` 결과로 돌려줘요.

## 언어 적합성 묶음

`test/conformance/questions.ts`(질문)와 `test/conformance.test.ts`(돌리는 틀). 질문은 언어와 무관하고, 언어마다 같은 모양의 예제 저장소(이름이 같은 함수·상수·변수·provider·타입, barrel, 빼야 할 파일)에 던져 그 언어의 정답(`test/expected/<예제>/conformance/<질문>.json`)과 비교해요. 파일 경로처럼 언어마다 다른 값은 `conformance/fixture.json`의 자리표시자(`{pricingFile}` 등)로 채워요. 예제가 갖출 모양은 `questions.ts` 머리에 적혀 있어요.

질문에는 GitNexus 1.6.12가 hijo_app에서 놓친 경우(최상위 변수·provider의 사용처, barrel을 거친 사용처, 같은 이름 메서드)가 들어 있어요. 정답에는 항목마다 `confidence`와 `kindConfidence`가 적혀 있어서, 그 언어가 무엇을 정밀하게 내고 무엇을 추정으로 내는지가 정답 파일에 기록돼요.

같은 묶음을 추정 층으로도 돌려요(`RUNS`의 `layer: 'inferred'`: 정밀 색인기를 `CODE_ATLAS_DISABLE_INDEXERS`로 없는 것으로 쳐요). 결과는 언어마다 "추정 층 적합성: <예제>" 표(위 "추정 층")에 적어요. #220(Python)·#221(JS/TS)처럼 추정 규칙만 있는 언어도 같은 방법으로 표를 만들어요.
