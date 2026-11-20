import '../checkout/price.dart';
import '../shared/log.dart';

/// 상수는 읽어도 코드가 돌지 않아요. 흐름에 들지 않아요.
const refundFee = 1;

/// 환불: 앱 코드에서는 아무도 부르지 않아요(테스트만 불러요). 그래서 진입점이에요.
void refund(int amount) {
  final back = priceWithTax(amount) - refundFee;
  log('환불 $back');
}
