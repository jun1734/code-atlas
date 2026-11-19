/// 세금을 붙인 가격.
int withTax(int price) => price + price ~/ 10;

/// 기본 배송비(최상위 상수).
const shippingFee = 3000;

/// 할인율(%). 최상위 변수라 읽는 곳과 쓰는 곳이 다 있어요.
var discountPercent = 0;
