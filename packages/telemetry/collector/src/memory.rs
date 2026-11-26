//! The collector's memory ceilings under a size limit (`--max-export-bytes`) of `limit` bytes,
//! each the sum of terms. Most are enforced (a charge, a capacity or a cut refuses past them);
//! some are measured, where nothing refuses past them and the bound is how they were derived and
//! checked: each says which. `README.md` ("Memory ceilings") gives the same terms and the same
//! split; the tests hold resident memory to them.

use crate::{otlp, query, readers, store};

/// The most a response's bytes wait in the HTTP server's own write buffer: hyper's default
/// (8 KiB and 100 slices of 4 KiB), which the collector does not change.
pub const SERVER_BUFFER_BYTES: usize = 8192 + 4096 * 100;

/// What one export holds while it is read and decoded:
///
/// - its body as read: at most twice the limit while it grows without a declared length;
/// - its text decompressed, when it is gzip: the same again;
/// - what decoding is charged (`otlp::DECODE_SHARE` times the limit): its wire structures,
///   values and rows, which stay until the writer has stored them;
/// - what decoding is not charged (measured): serde_json's one scratch buffer, for the export and
///   for the value it is reading, which it uses both to unescape a string and to collect the
///   digits of a long number (`float_roundtrip`: a number of more than 19 significant digits, or
///   any with a long fraction, whether valid or about to be refused as the wrong kind). For a
///   string it holds as much as the string (its copy is charged); for a number it grows by
///   doubling as it collects the digits, holding the old buffer beside the new one: up to three
///   times the longest number (measured, at most 2.46 times), so at most three times the limit.
///   serde_json
///   collects a number's digits before any visitor sees it, even to say it is the wrong type, so
///   a field cannot refuse a number without them.
///
/// `tests/memory.rs` measures what decoding holds against what it was charged for a corpus of
/// export shapes.
pub fn export_bytes(limit: usize) -> usize {
    (2 + 2 + otlp::DECODE_SHARE + 3) * limit
}

/// What one reader holds for an answer:
///
/// - a trace's skeleton, `query::SKELETON_BYTES`;
/// - the row it is writing and its resource's text, each at most `otlp::ROW_SHARE` times the
///   limit (`otlp` refuses a larger row), and SQLite's copy of one of them while it is read;
/// - the resources it keeps, `query::RESOURCE_CACHE_BYTES`;
/// - its response: `readers::BODY_CHUNKS` chunks queued and one being filled, of
///   `readers::CHUNK_BYTES`, and the server's buffer;
/// - its connection's page cache, `readers::READER_CACHE_BYTES`.
pub fn reader_bytes(limit: usize) -> usize {
    query::SKELETON_BYTES
        + 3 * otlp::ROW_SHARE * limit
        + query::RESOURCE_CACHE_BYTES
        + (readers::BODY_CHUNKS + 1) * readers::CHUNK_BYTES
        + SERVER_BUFFER_BYTES
        + readers::READER_CACHE_BYTES
}

/// What the writer holds besides the exports it stores (`export_bytes` counts their rows): its
/// page cache, `store::WRITER_CACHE_BYTES`; for the row it is writing, at most `otlp::ROW_SHARE`
/// times the limit of text, SQLite's copy of its values as they are bound, the record it builds,
/// and the stored row it reads back to compare; and at most `store::SUMMARY_BATCH` fixed-size
/// trace summaries (`store::SUMMARY_BYTES`), in a table at most four times their size while it
/// grows, never a copy of a name.
pub fn writer_bytes(limit: usize) -> usize {
    store::WRITER_CACHE_BYTES
        + 3 * otlp::ROW_SHARE * limit
        + 4 * (store::SUMMARY_BYTES + 1) * store::SUMMARY_BATCH
}

/// All of it: `pending` exports at once (`--max-pending`), the readers and the writer. The
/// process's own code, stacks and runtime are not counted (about 7 MiB at rest).
pub fn ceiling_bytes(limit: usize, pending: usize) -> usize {
    pending * export_bytes(limit) + readers::READERS * reader_bytes(limit) + writer_bytes(limit)
}
