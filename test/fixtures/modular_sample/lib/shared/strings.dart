// 모두가 쓰는 문자열 도우미.
String title(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

// 아무도 부르지 않는 공개 함수.
String shout(String s) => '${s.toUpperCase()}!';

String _whisper(String s) => s.toLowerCase();
