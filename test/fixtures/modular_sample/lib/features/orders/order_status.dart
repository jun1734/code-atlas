// 주문 상태. 이름표는 part 파일에 있어요.
import '../../shared/toast.dart';

part 'order_status_labels.dart';

enum OrderStatus { placed, shipped }

String announce(OrderStatus status) => toast(status);
