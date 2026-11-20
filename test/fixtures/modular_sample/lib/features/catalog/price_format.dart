// 가격 표시 도우미. 다른 기능 폴더가 가져다 쓰면 리뷰 후보예요.
String formatPrice(int won) => '$won원';

// 아무도 부르지 않는 공개 함수.
String formatCents(int cents) => '${cents / 100}';
