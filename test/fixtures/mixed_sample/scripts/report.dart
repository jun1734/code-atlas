// Dart 패키지 밖의 스크립트. scip-dart는 패키지만 색인해서 이 파일은 추정 층이 색인해요.
import '../app/lib/cart.dart';

String buildReport() {
  final cart = Cart();
  return 'total: ' + cart.total().toString();
}

void main() {
  print(buildReport());
}
