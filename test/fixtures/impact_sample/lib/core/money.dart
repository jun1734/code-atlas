// 금액 도우미. won은 여러 곳에서 아주 많이 써요(많이 쓰이는 이름).
String won(int amount) => '$amount원';

int withVat(int amount) => amount + amount ~/ 10;
