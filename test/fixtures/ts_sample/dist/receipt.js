// 빌드 산출물이에요. 색인에서 기본으로 빠져야 해요.
import { withTax } from '../src/index.ts';

export function receipt(price) {
  return withTax(price);
}
