const { currentDiscount, shippingFee, withTax } = require('./pricing');

/**
 * 합계를 내는 것(JavaScript에는 인터페이스가 없어서 JSDoc의 @interface로 적어요).
 * @interface
 */
class Totaled {
  /** @returns {number} */
  total() {
    throw new Error('구현해야 해요');
  }
}

/** 이름표를 붙이는 바탕 타입. */
class Labeled {
  get label() {
    return 'cart';
  }
}

/** @implements {Totaled} */
class Cart extends Labeled {
  constructor() {
    super();
    /** @type {number[]} */
    this.prices = [];
  }

  add(price) {
    this.prices.push(price - Math.floor((price * currentDiscount()) / 100));
  }

  total() {
    let sum = 0;
    for (const p of this.prices) {
      sum += withTax(p);
    }
    return sum + shippingFee;
  }
}

class GiftCart extends Cart {}

class Wishlist {
  constructor() {
    /** @type {number[]} */
    this.prices = [];
  }

  add(price) {
    this.prices.push(price);
  }
}

module.exports = { Totaled, Labeled, Cart, GiftCart, Wishlist };
