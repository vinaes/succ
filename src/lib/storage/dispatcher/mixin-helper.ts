export function applyMixins(
  derivedCtor: { prototype: object },
  constructors: Array<{ prototype: object }>
): void {
  for (const baseCtor of constructors) {
    for (const name of Object.getOwnPropertyNames(baseCtor.prototype)) {
      if (name === 'constructor') continue;
      Object.defineProperty(
        derivedCtor.prototype,
        name,
        Object.getOwnPropertyDescriptor(baseCtor.prototype, name) ?? Object.create(null)
      );
    }
  }
}
