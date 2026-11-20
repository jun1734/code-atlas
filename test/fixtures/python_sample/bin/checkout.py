from shop import Cart, GiftCart, cartProvider, setDiscount, totalProvider, withTax


def main() -> None:
    setDiscount(10)
    cart = cartProvider()
    cart.add(1000)
    tax = withTax
    print(tax(500) + withTax(500))
    print(cart.total() + totalProvider())
    print(GiftCart().label)
    spare: Cart = Cart()
    spare.add(1)


if __name__ == '__main__':
    main()
