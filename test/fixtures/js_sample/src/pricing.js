// 설정 파일(package.json, tsconfig.json, jsconfig.json)이 없는 순수 JavaScript(CommonJS) 예제예요.

/** 세금을 붙인 가격. */
function withTax(price) {
  return price + Math.floor(price / 10);
}

/** 기본 배송비(최상위 상수). */
const shippingFee = 3000;

/** 할인율(%). 최상위 변수라 읽는 곳과 쓰는 곳이 다 있어요. */
let discountPercent = 0;

/** 할인율을 바꿔요. */
function setDiscount(percent) {
  discountPercent = percent;
  discountPercent += 0;
}

/** 지금 할인율. CommonJS로 내보낸 변수는 값이 복사돼서, 바뀐 값을 읽는 함수를 둬요. */
function currentDiscount() {
  return discountPercent;
}

module.exports = { withTax, shippingFee, setDiscount, currentDiscount };
