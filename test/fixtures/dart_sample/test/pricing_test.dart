import 'package:dart_sample/dart_sample.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  if (withTax(100) != 110) throw StateError('withTax');
  discountPercent += 5;
  final container = ProviderContainer();
  if (container.read(cartProvider).total() != shippingFee) throw StateError('total');
}
