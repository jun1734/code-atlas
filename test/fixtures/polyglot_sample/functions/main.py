import billing


def handle(price: int) -> str:
    return billing.formatReceipt(price)
