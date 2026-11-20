class LineItem {
  final double price;
  final int qty;
  LineItem(this.price, this.qty);
  double amount() => price * qty;
}
