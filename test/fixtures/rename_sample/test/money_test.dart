import 'package:rename_sample/rename_sample.dart';

void main() {
  final money = Money.zero()..cents = 10;
  if (money.cents != 10) throw StateError('cents');
  if (withTax(100) != 110) throw StateError('withTax');
}
