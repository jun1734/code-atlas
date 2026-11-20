import 'chat/chat.dart';
import 'checkout/checkout.dart';

/// 앱 시작: 결제 한 번, 대화 한 번. 아무도 부르지 않는 진입점이에요.
void main() {
  pay(100);
  openChat();
}
