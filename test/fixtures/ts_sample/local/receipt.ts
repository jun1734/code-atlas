// git이 무시하는 폴더예요. 색인에서 기본으로 빠져야 해요.
import { withTax } from '../src/index.ts';

export function receipt(price: number): number {
  return withTax(price);
}
