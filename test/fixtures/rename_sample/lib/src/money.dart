/// 세금을 붙여요.
int withTax(int amount) => amount + amount ~/ 10;

/// 올림. withTax를 이 이름으로 바꾸면 같은 파일의 이름과 겹쳐요.
int roundUp(int amount) => amount;

/// 스스로를 글로 적는 것.
abstract interface class Describable {
  String describe();
}

class Money implements Describable {
  int _cents;

  Money(this._cents);

  Money.zero() : _cents = 0;

  int get cents => _cents;

  set cents(int value) => _cents = value;

  int get taxed => withTax(cents);

  @override
  String describe() => 'Money($cents, $taxed)';
}
