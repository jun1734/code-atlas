import { discountPercent, shippingFee, withTax } from './pricing.ts';

/** 합계를 내는 것. */
export interface Totaled {
  total(): number;
}

/** 이름표를 붙이는 바탕 타입(TypeScript에는 mixin 문법이 없어서 바탕 클래스예요). */
export class Labeled {
  get label(): string {
    return 'cart';
  }
}

export class Cart extends Labeled implements Totaled {
  readonly prices: number[] = [];

  add(price: number): void {
    this.prices.push(price - Math.floor((price * discountPercent) / 100));
  }

  total(): number {
    let sum = 0;
    for (const p of this.prices) {
      sum += withTax(p);
    }
    return sum + shippingFee;
  }
}

export class GiftCart extends Cart {}

export class Wishlist {
  readonly prices: number[] = [];

  add(price: number): void {
    this.prices.push(price);
  }
}
