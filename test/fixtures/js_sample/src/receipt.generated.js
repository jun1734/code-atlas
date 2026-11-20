// @generated
// 생성된 코드예요. 색인에서 기본으로 빠져야 해요.
const { withTax } = require('./pricing');

function receipt(price) {
  return withTax(price);
}

module.exports = { receipt };
