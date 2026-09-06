/**
 * Bind a method bag to a GPU host. Used by named collaborators so mixin
 * objects are not Object.assign'd onto MultiDeviceVisualizer.prototype.
 */
export function bindHostMethods<T extends object>(methods: T, host: object): T {
  const out = {} as T;
  for (const key of Object.keys(methods) as Array<keyof T>) {
    const val = methods[key];
    (out as Record<string, unknown>)[key as string] =
      typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(host) : val;
  }
  return out;
}
