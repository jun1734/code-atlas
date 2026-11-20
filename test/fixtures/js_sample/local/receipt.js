// git이 무시하는 폴더예요. 색인에서 기본으로 빠져야 해요.
const { withTax } = require('../src/index');

function receipt(price) {
  return withTax(price);
}

module.exports = { receipt };
