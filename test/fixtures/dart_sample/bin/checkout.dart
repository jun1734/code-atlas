import 'package:dart_sample/dart_sample.dart';

void main() {
  final cart = Cart()..add(1000);
  print(withTax(500));
  print(cart.total());
}
