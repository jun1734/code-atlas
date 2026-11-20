import 'money.dart';

class Cart {
  final List<int> prices = [];

  int total() => withVat(prices.fold(0, (a, b) => a + b));
}
