// 언어 적합성 질문 묶음. 언어와 무관한 질문이라, 언어마다 "같은 모양"의 예제 저장소에 그대로 던져요.
// 정답은 언어마다 `test/expected/<예제>/conformance/<질문 id>.json`에 두고,
// 파일 경로처럼 언어마다 다른 값은 `test/expected/<예제>/conformance/fixture.json`의 자리표시자로 채워요.
//
// 같은 모양의 예제 저장소가 갖출 것(이름은 언어와 무관하게 같아요):
// - 모듈 수준 함수 withTax, 상수 shippingFee, 변수 discountPercent(어딘가에서 쓰고 어딘가에서 읽어요).
// - provider(그 언어의 모듈 수준 값) cartProvider, totalProvider. totalProvider는 cartProvider를 읽어요.
// - 타입: 인터페이스 Totaled, mixin(없는 언어는 바탕 타입) Labeled와 그 getter label,
//   Cart(Labeled를 섞고 Totaled를 구현),
//   GiftCart(Cart를 상속), Wishlist. Cart와 Wishlist에는 이름이 같은 메서드 add가 있어요.
// - 다시 내보내는 파일(barrel)이 위 이름을 모두 내보내고, 앱 진입점과 테스트는 barrel만 가져다 써요.
// - 앱 진입점과 테스트에 각각 main이 있어요(이름이 같은 함수).
// - receipt 함수가 생성된 파일, 빌드 산출물 폴더, git이 무시하는 폴더에 하나씩 있어요. 셋 다 색인에서 빠져야 해요.
//
// 어느 질문이 GitNexus 1.6.12가 hijo_app에서 놓친 경우인지는 why에 적어요(#204, #212).

export interface ConformanceQuestion {
  id: string;
  /** 이 질문이 확인하는 것. */
  why: string;
  /** 명령줄 인자. `{이름}`은 예제의 fixture.json 값으로 바꿔요. */
  args: string[];
  /**
   * 'reask-candidates-by-key': 답이 후보 목록이어야 하고, 후보마다 그 key로 다시 물으면
   * 그 후보 하나가 found로 나와야 해요(정답 파일은 첫 답만 담아요).
   */
  then?: 'reask-candidates-by-key';
}

export const QUESTIONS: ConformanceQuestion[] = [
  {
    id: 'module-function',
    why: '모듈 수준 함수의 호출과 함수 값으로 읽는 곳, barrel을 거친 사용처, 앱/테스트 구분',
    args: ['context', 'withTax'],
  },
  {
    id: 'module-constant',
    why: '최상위 상수의 사용처(GitNexus: 0개)',
    args: ['context', 'shippingFee'],
  },
  {
    id: 'module-variable',
    why: '최상위 변수의 읽기와 쓰기(GitNexus: 0개)',
    args: ['context', 'discountPercent'],
  },
  {
    id: 'provider',
    why: 'provider의 사용처: 다른 provider와 앱, 테스트에서 읽는 곳(GitNexus: 4개 중 0개)',
    args: ['context', 'cartProvider'],
  },
  {
    id: 'provider-dependent',
    why: '다른 provider를 읽는 provider의 사용처',
    args: ['context', 'totalProvider'],
  },
  {
    id: 'class',
    why: 'barrel을 거친 클래스 사용처: 생성자 호출, 상속, 타입으로 쓰인 곳(GitNexus: 21곳 중 3곳)',
    args: ['context', 'Cart'],
  },
  {
    id: 'interface',
    why: '인터페이스를 구현하는 곳',
    args: ['context', 'Totaled'],
  },
  {
    id: 'mixin',
    why: 'mixin을 섞는 곳(상속으로 나와요)',
    args: ['context', 'Labeled'],
  },
  {
    id: 'getter',
    why: 'getter를 하위 타입의 값으로 읽는 곳',
    args: ['context', 'label'],
  },
  {
    id: 'same-name-method',
    why: '이름이 같은 메서드는 하나를 고르지 않고 후보를 돌려줘요',
    args: ['context', 'add'],
  },
  {
    id: 'same-name-method-pick',
    why: '후보의 바깥 타입을 붙인 이름으로 다시 물으면 그 하나만 나와요',
    args: ['context', 'Wishlist.add'],
  },
  {
    id: 'same-name-function-pick-by-key',
    why: '바깥 타입이 없어 이름이 겹치는 함수(main)도 후보의 key로 다시 물을 수 있어요',
    args: ['context', 'main'],
    then: 'reask-candidates-by-key',
  },
  {
    id: 'file',
    why: '파일 하나: 정의하는 이름, 가져다 쓰는 파일, 쓰이는 파일(barrel을 거친 것 포함)',
    args: ['context', '{pricingFile}'],
  },
  {
    id: 'file-barrel',
    why: '다시 내보내는 파일(barrel) 자체를 물으면 내보내는 파일과 가져다 쓰는 파일이 나와요',
    args: ['context', '{barrelFile}'],
  },
  {
    id: 'excluded-symbol',
    why: '생성된 코드, 빌드 산출물, git이 무시하는 폴더에만 있는 이름은 색인에 없어요',
    args: ['context', 'receipt'],
  },
  {
    id: 'excluded-file',
    why: '생성된 파일은 파일로 물어도 색인에 없어요',
    args: ['context', '{generatedFile}'],
  },
];
