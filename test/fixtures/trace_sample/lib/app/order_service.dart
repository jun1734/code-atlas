import '../data/audit.dart';
import '../data/db.dart';
import '../data/order_repository.dart';

class OrderService {
  final OrderRepository repo = OrderRepository();

  /// 검사하고 저장소를 거쳐 저장해요(길 둘: 저장소로, 감사 기록으로).
  void placeOrder(int id) {
    validate(id);
    repo.save(id);
  }

  /// 저장소를 거치지 않고 바로 저장해요(가장 짧은 길).
  void quickOrder(int id) => writeRow(id);

  void validate(int id) {
    logAudit(id);
  }
}
