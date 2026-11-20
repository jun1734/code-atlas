import 'sender.dart';

class Message {
  final Sender sender;
  final String text;
  Message(this.sender, this.text);
  String display() => '${sender.name}: $text';
}
