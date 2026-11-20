/// 세금을 붙인 가격(Python 쪽 functions/billing/tax.py에도 같은 이름이 있어요).
int withTax(int price) => price + price ~/ 10;
