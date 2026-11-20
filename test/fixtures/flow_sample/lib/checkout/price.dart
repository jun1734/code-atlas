int priceWithTax(int amount) => roundUp(amount + amount ~/ 10);

int roundUp(int value) => value + 10 - value % 10;
