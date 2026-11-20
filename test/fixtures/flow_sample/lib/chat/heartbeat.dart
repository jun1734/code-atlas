/// 서로만 부르는 두 함수. 밖에서 부르는 곳이 없어 둘 다 "불리는" 이름이지만, 이 순환이 흐름 하나의 시작이에요.
void ping(int n) {
  if (n > 0) pong(n - 1);
}

void pong(int n) {
  if (n > 0) ping(n - 1);
}
