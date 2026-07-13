// Gzip helpers for the pairing snapshot. The native host compresses the snapshot
// with flate2's GzEncoder — an RFC 1952 gzip container (header + trailer), not
// raw deflate — so we use the platform's gzip CompressionStream to match.

export async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
