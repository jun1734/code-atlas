import '../shared/log.dart';

void openChat() {
  connect();
  sendHello();
}

void connect() => log('연결 $roomName');

void sendHello() => log(greeting);

/// 최상위 getter: 읽을 때마다 본문이 돌아요. 그래서 읽기도 흐름에 들어요.
String get roomName => '대화방';

/// 모듈 수준 변수: 처음 읽을 때 초기화 식(makeGreeting 부르기)이 돌아요. 그래서 읽기도 흐름에 들어요.
final greeting = makeGreeting();

String makeGreeting() => '안녕';
