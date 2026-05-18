type PromiseWithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseWithResolvers<T>;
};

const promiseConstructor = Promise as PromiseConstructorWithResolvers;

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

