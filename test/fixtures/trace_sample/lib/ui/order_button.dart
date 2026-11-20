import '../app/order_service.dart';

/// 주문 버튼. 누르면 두 가지 길로 저장까지 가요.
class OrderButton {
  final OrderService service;

  OrderButton(this.service);

  void onPressed() {
    service.placeOrder(1);
    service.quickOrder(1);
  }
}
