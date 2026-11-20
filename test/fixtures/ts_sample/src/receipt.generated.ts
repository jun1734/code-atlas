// @generated
// 생성된 코드예요. 색인에서 기본으로 빠져야 해요.
import { withTax } from './pricing.ts';

export function receipt(price: number): number {
  return withTax(price);
}
