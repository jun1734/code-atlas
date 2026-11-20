def withTax(price: int) -> int:
    """세금을 붙인 가격(Dart 쪽 app/lib/money.dart에도 같은 이름이 있어요)."""
    return price + price // 10


def formatReceipt(price: int) -> str:
    return f'{withTax(price)}원'
