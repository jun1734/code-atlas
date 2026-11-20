const { Cart, Container, cartProvider, setDiscount, shippingFee, withTax } = require('../src/index');

function main() {
  if (withTax(100) !== 110) throw new Error('withTax');
  setDiscount(5);
  const container = new Container();
  if (container.read(cartProvider).total() !== shippingFee) throw new Error('total');
  if (new Cart().total() < 0) throw new Error('cart');
}

module.exports = { main };
