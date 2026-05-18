type PromiseWithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseWithResolvers<T>;
  try?: <T>(callback: (...args: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) => Promise<T>;
};

type ArrayPrototypeWithFindLast = Array<unknown> & {
  findLast?: <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => boolean
  ) => T | undefined;
};

const promiseConstructor = Promise as PromiseConstructorWithResolvers;
const arrayPrototype = Array.prototype as ArrayPrototypeWithFindLast;

if (typeof promiseConstructor.withResolvers !== "function") {
  promiseConstructor.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, resolve, reject };
  };
}

if (typeof promiseConstructor.try !== "function") {
  promiseConstructor.try = <T>(
    callback: (...args: unknown[]) => T | PromiseLike<T>,
    ...args: unknown[]
  ) => new Promise<T>((resolve) => resolve(callback(...args)));
}

if (typeof arrayPrototype.findLast !== "function") {
  Object.defineProperty(arrayPrototype, "findLast", {
    value<T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean
    ): T | undefined {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (predicate(this[index], index, this)) return this[index];
      }
      return undefined;
    }
  });
}
