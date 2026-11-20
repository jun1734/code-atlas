const { Cart, Container, GiftCart, cartProvider, setDiscount, totalProvider, withTax } = require('./index');

function main() {
  setDiscount(10);
  const container = new Container();
  const cart = container.read(cartProvider);
  cart.add(1000);
  const tax = withTax;
  console.log(tax(500) + withTax(500));
  console.log(cart.total() + container.read(totalProvider));
  console.log(new GiftCart().label);
  /** @type {Cart} */
  const spare = new Cart();
  spare.add(1);
}

main();
