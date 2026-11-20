String won(int amount) => '$amount won';

int withVat(int amount) {
  final vat = amount ~/ 10;
  return amount + vat;
}

int rounded(int amount) => amount - amount % 10;
