export function bufferToBytea(buffer: Buffer) {
  return `\\x${buffer.toString("hex")}`;
}

export function byteaToBuffer(value: string | Uint8Array | Buffer) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(value, "hex");
}
