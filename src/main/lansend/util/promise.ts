/**
 * `Promise.withResolvers` polyfill.
 *
 * The function is ES2024 (Node 22). YangGe ships on Electron 22, whose main
 * process runs Node 16, so the library cannot assume it exists. Defining it
 * once here keeps every call site unchanged and makes the dependency explicit.
 *
 * The type mirrors the standard library signature exactly, so code written
 * against this module type-checks the same way it would against `lib.es2024`.
 */

export interface Resolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function withResolvers<T>(): Resolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Installs the polyfill on the global `Promise` when the runtime lacks it.
 *
 * Only needed when third-party code calls `Promise.withResolvers` directly.
 * First-party code imports `withResolvers` from this module instead, so this
 * exists purely as a safety net for vendored dependencies.
 */
export function ensurePromiseWithResolvers(): void {
  const ctor = Promise as unknown as { withResolvers?: unknown };
  if (typeof ctor.withResolvers === 'function') return;
  ctor.withResolvers = withResolvers;
}
