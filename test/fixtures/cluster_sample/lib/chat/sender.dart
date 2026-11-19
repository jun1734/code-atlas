import 'message.dart';

class Sender {
  final String name;
  Sender(this.name);
  Message say(String text) => Message(this, text);
}
