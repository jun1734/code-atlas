import 'price.dart';
import 'receipt.dart';

/// 결제: 값을 매기고 영수증을 남겨요. main이 부르지만 설정(.code-atlas.json)이 진입점으로도 지정해요.
void pay(int amount) {
  final total = priceWithTax(amount);
  printReceipt(total);
}
