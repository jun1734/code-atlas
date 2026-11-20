import { Cart } from './cart.ts';

/** provider: 컨테이너에서 값을 만드는 모듈 수준 값(Riverpod을 흉내 낸 작은 꼴). */
export type Provider<T> = (container: Container) => T;

export class Container {
  read<T>(provider: Provider<T>): T {
    return provider(this);
  }
}

export const cartProvider: Provider<Cart> = () => new Cart();

export const totalProvider: Provider<number> = (container) => container.read(cartProvider).total();
