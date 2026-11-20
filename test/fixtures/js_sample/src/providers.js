const { Cart } = require('./cart');

/** provider: 컨테이너에서 값을 만드는 모듈 수준 값(Riverpod을 흉내 낸 작은 꼴). */
class Container {
  /**
   * JSDoc 타입이 있어야 돌려준 값의 타입(Cart)을 알 수 있어요. 없으면 any라 그 값의 메서드를 정밀 층도 잇지 못해요.
   * @template T
   * @param {(container: Container) => T} provider
   * @returns {T}
   */
  read(provider) {
    return provider(this);
  }
}

const cartProvider = () => new Cart();

/** @param {Container} container */
const totalProvider = (container) => container.read(cartProvider).total();

module.exports = { Container, cartProvider, totalProvider };
