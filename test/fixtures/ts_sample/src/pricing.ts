/** 세금을 붙인 가격. */
export function withTax(price: number): number {
  return price + Math.floor(price / 10);
}

/** 기본 배송비(최상위 상수). */
export const shippingFee = 3000;

/** 할인율(%). 최상위 변수라 읽는 곳과 쓰는 곳이 다 있어요. */
export let discountPercent = 0;

/** 할인율을 바꿔요. ES 모듈의 가져온 변수는 다른 파일에서 쓸 수 없어서 쓰는 곳이 여기 있어요. */
export function setDiscount(percent: number): void {
  discountPercent = percent;
  discountPercent += 0;
}
