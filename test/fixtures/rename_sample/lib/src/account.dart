import 'money.dart';

class Account {
  final Money balance = Money.zero();

  void deposit(int amount) {
    balance.cents = balance.cents + withTax(amount);
  }

  String get summary => 'Account: ${balance.describe()} (${withTax(1)})';
}

void resetAll(List<Account> accounts) {
  for (final a in accounts) {
    a.balance.cents = 0;
  }
}
