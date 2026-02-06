/**
 * Helper utilities for database operations
 */

/**
 * Safely convert Buffer to Float32Array, handling byte offset and alignment correctly.
 * Float32Array requires 4-byte alignment, so we copy the buffer to ensure alignment.
 */
export function bufferToFloatArray(buffer: Buffer): number[] {
  // Copy buffer to ensure 4-byte alignment for Float32Array
  const aligned = Buffer.from(buffer);
  const floatArray = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
}

/**
 * Convert number[] to Buffer for sqlite-vec
 */
export function floatArrayToBuffer(arr: number[]): Buffer {
  const float32 = new Float32Array(arr);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}
