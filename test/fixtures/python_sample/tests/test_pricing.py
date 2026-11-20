from shop import Cart, cartProvider, shippingFee, withTax


def main() -> None:
    if withTax(100) != 110:
        raise AssertionError('withTax')
    if cartProvider().total() != shippingFee:
        raise AssertionError('total')
    if Cart().total() < 0:
        raise AssertionError('cart')


if __name__ == '__main__':
    main()
