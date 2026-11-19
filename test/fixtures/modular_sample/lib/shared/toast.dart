// 공용 알림. 주문 상태를 가져다 써서 흐름을 거스르고, 주문 상태와 서로 물려요.
import '../features/orders/order_status.dart';

String toast(OrderStatus status) => '알림: ${status.name}';
