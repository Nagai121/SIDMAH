export class SidmahError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SidmahError";
  }
}

export function invariant(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new SidmahError(code, message);
}
