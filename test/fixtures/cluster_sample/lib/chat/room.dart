import '../billing/tax.dart';
import 'message.dart';
import 'sender.dart';

class Room {
  final List<Message> messages = [];
  Sender join(String name) => Sender(name);
  void post(Message message) => messages.add(message);
  String transcript() => messages.map((Message m) => m.display()).join('\n');
  // 결제 덩어리로 가는 약한 연결 하나.
  String tipWithTax(double tip) => withTax(tip).toString();
}
