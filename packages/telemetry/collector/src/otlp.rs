//! OTLP/HTTP JSON exports, decoded into the rows the store keeps.
//!
//! Only the fields the collector stores are decoded; serde ignores the rest. The mapping follows
//! what Motel stored, so the same exports read back the same way:
//!
//! - Attribute values become strings: arrays are joined with a space, key-value lists become JSON,
//!   bytes stay base64. `intValue` keeps its decimal digits; Motel turned it into a JavaScript
//!   number first and lost precision above 2^53.
//! - A value inside more than [`VALUE_DEPTH`] arrays and key-value lists is kept as its JSON
//!   text instead, so no depth refuses an export.
//! - Trace and span ids are hex of the right length, in either case, or canonical base64. A span
//!   whose id is neither makes the export invalid. A log's ids only correlate it with a span, so
//!   an id that cannot be read is dropped instead.
//! - The service name is `service.name`, then `service_name`, then `unknown`.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;
use std::mem::size_of;

use serde::Deserialize;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;

// --- Messages --------------------------------------------------------------------------------
//
// A message about an export goes back to its sender and into the log, so it never grows with
// the export: it names the field and quotes at most `EXCERPT_CHARS` of an offending value
// (`Excerpt`), and a message serde_json made, which can quote a whole value, is written through a
// writer that stops at `MESSAGE_BYTES` (`bounded`), so no longer copy of it is made.

/// The most bytes of a message about an export.
pub const MESSAGE_BYTES: usize = 256;

/// How many characters of an offending value a message quotes, and how many bytes they may take
/// once escaped.
const EXCERPT_CHARS: usize = 24;
const EXCERPT_BYTES: usize = 96;

/// `value` written as text, at most `MESSAGE_BYTES` of it.
pub fn bounded(value: impl std::fmt::Display) -> String {
    struct Capped(String);
    impl std::fmt::Write for Capped {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            let room = MESSAGE_BYTES.saturating_sub(self.0.len());
            if text.len() <= room {
                self.0.push_str(text);
                return Ok(());
            }
            let mut end = room;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            self.0.push_str(&text[..end]);
            // Stops the formatting: nothing past the cap is made.
            Err(std::fmt::Error)
        }
    }
    let mut capped = Capped(String::with_capacity(64));
    let _ = std::fmt::Write::write_fmt(&mut capped, format_args!("{value}"));
    capped.0
}

/// The start of an offending value, quoted, and its length when that is not all of it.
struct Excerpt<'a>(&'a str);

impl std::fmt::Display for Excerpt<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // At most `EXCERPT_CHARS` characters and `EXCERPT_BYTES` bytes once escaped, so a value of
        // escapes is cut as short as one of letters.
        let (mut end, mut escaped) = (0, 0);
        for (count, (at, character)) in self.0.char_indices().enumerate() {
            let width: usize = character.escape_debug().map(char::len_utf8).sum();
            if count == EXCERPT_CHARS || escaped + width > EXCERPT_BYTES {
                break;
            }
            escaped += width;
            end = at + character.len_utf8();
        }
        write!(formatter, "{:?}", &self.0[..end])?;
        if end < self.0.len() {
            write!(formatter, "... ({} bytes)", self.0.len())?;
        }
        Ok(())
    }
}

/// The most bytes a name may have: a span's, an event's or a scope's name, an attribute's key at
/// any depth, a service's name and a log's severity. An export with a longer one is refused, so
/// whatever holds names (lists, headers, summaries, indexes, stats) holds them in a bounded size.
/// Motel took any length.
pub const NAME_BYTES: usize = 4096;

/// `text`, the `what` of the export, if it is no longer than `NAME_BYTES`.
fn short_name<'t>(what: &str, text: &'t str) -> Result<&'t str, Invalid> {
    if text.len() <= NAME_BYTES {
        return Ok(text);
    }
    Err(Invalid(format!(
        "{what} is {} bytes; a name may be at most {NAME_BYTES}",
        text.len()
    )))
}

/// Why an export could not be decoded. The message is returned to the sender.
#[derive(Debug)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

// --- What decoding may hold --------------------------------------------------------------------
//
// Decoding an export builds its wire structures, its attribute values and its rows. Every
// allocation whose size depends on the export is charged to the export's budget as it is made, at
// an upper bound of what it holds: twice an element's size in a list that grows by doubling, a
// string's capacity, a map entry twice. Nothing charged is given back while the export decodes,
// so what decoding holds at any moment is at most what it was charged, besides two things that
// are not: text unescaped from the export, never longer than the text it came from, so at most the
// body's length in all; and the one value being converted at a time (a number's digits, a value's
// string), freed before the next.

/// What decoding one export may be charged, as a multiple of `--max-export-bytes`. An export
/// charged more is refused as too large (413, `tooLarge`), so the rows of one export, the
/// structures they are built from and the trees of its values take at most this many times the
/// size limit.
pub const DECODE_SHARE: usize = 8;

/// The most text one row may store, as a multiple of `--max-export-bytes`: escaping can make a
/// value's text longer than the export spelled it, up to about three times for a value kept as
/// its JSON text inside a key-value list. A row past it is refused as too large, so reading a row
/// back holds at most this.
pub const ROW_SHARE: usize = 4;

/// Why an export was not decoded.
#[derive(Debug)]
pub enum Undecodable {
    Invalid(Invalid),
    /// Decoding it would take more than its budget.
    TooLarge,
}

/// The budget of the export decoding on a thread.
#[derive(Clone, Copy)]
struct Budget {
    /// What it may still be charged.
    left: usize,
    /// It went over.
    over: bool,
    /// The most text one row may store, `ROW_SHARE` times the size limit.
    row_bytes: usize,
    /// What it holds charged now.
    charged: usize,
    /// The most it has held charged.
    peak: usize,
}

const UNBOUNDED: Budget = Budget {
    left: usize::MAX,
    over: false,
    row_bytes: usize::MAX,
    charged: 0,
    peak: 0,
};

thread_local! {
    static BUDGET: Cell<Budget> = const { Cell::new(UNBOUNDED) };
}

/// Charge `bytes` to the export decoding on this thread. `false` once over its budget.
fn afford(bytes: usize) -> bool {
    BUDGET.with(|cell| {
        let mut budget = cell.get();
        budget.charged = budget.charged.saturating_add(bytes);
        budget.peak = budget.peak.max(budget.charged);
        match budget.left.checked_sub(bytes) {
            Some(left) if !budget.over => budget.left = left,
            _ => {
                budget.left = 0;
                budget.over = true;
            }
        }
        cell.set(budget);
        !budget.over
    })
}

/// Give back the charge of `bytes` freed while the export decodes.
fn release(bytes: usize) {
    BUDGET.with(|cell| {
        let mut budget = cell.get();
        budget.charged = budget.charged.saturating_sub(bytes);
        if !budget.over {
            budget.left = budget.left.saturating_add(bytes);
        }
        cell.set(budget);
    });
}

/// A row whose texts take `bytes`: refused as too large past `Budget::row_bytes`.
fn row_fits(bytes: usize) -> Result<(), Invalid> {
    if bytes <= BUDGET.with(|cell| cell.get().row_bytes) {
        return Ok(());
    }
    BUDGET.with(|cell| {
        cell.set(Budget {
            over: true,
            ..cell.get()
        })
    });
    Err(Invalid(
        "a row of the export is larger than a row may be".to_owned(),
    ))
}

/// [`afford`], as an error inside serde.
fn charge<E: serde::de::Error>(bytes: usize) -> Result<(), E> {
    if afford(bytes) {
        Ok(())
    } else {
        Err(E::custom("the export takes more than its budget to decode"))
    }
}

/// [`afford`], as an error building rows.
fn charge_rows(bytes: usize) -> Result<(), Invalid> {
    if afford(bytes) {
        Ok(())
    } else {
        Err(Invalid(
            "the export takes more than its budget to decode".to_owned(),
        ))
    }
}

/// What glibc's allocator takes for a request of `bytes`: the request and its 8-byte header,
/// rounded up to 16 and at least 32. Charges are in these terms, so what they allow is what the
/// heap holds.
fn heap(bytes: usize) -> usize {
    if bytes == 0 {
        0
    } else {
        (bytes.saturating_add(23) & !15).max(32)
    }
}

/// What a hash table of at least `items` entries of `entry` bytes allocates: hashbrown's buckets,
/// a power of two holding the entries at seven eighths full, and a control byte for each and a
/// group's more.
fn table_bytes(items: usize, entry: usize) -> usize {
    if items == 0 {
        return 0;
    }
    let buckets = match items {
        0..4 => 4,
        4..8 => 8,
        _ => (items.saturating_mul(8) / 7).next_power_of_two(),
    };
    heap(buckets.saturating_mul(entry + 1) + 16)
}

/// When `items` is full, charge its new allocation (the old one, charged when it was made, is
/// copied from and then freed), then grow it to exactly that: lists grow only as they are
/// charged.
fn room_for<T>(items: &mut Vec<T>) -> bool {
    room_up_to(items, usize::MAX)
}

/// [`room_for`], growing to at most `most` items.
fn room_up_to<T>(items: &mut Vec<T>, most: usize) -> bool {
    if items.len() < items.capacity() {
        return true;
    }
    let grown = items.capacity().saturating_mul(2).max(4).min(most);
    let size = size_of::<T>();
    // The old allocation is charged already and stays while it is copied from; then it is freed.
    let old = heap(items.capacity() * size);
    if !afford(heap(grown.saturating_mul(size))) {
        return false;
    }
    items.reserve_exact(grown - items.len());
    release(old);
    true
}

/// [`room_for`], as an error inside serde.
fn room<T, E: serde::de::Error>(items: &mut Vec<T>) -> Result<(), E> {
    if room_for(items) {
        Ok(())
    } else {
        Err(over_budget())
    }
}

/// [`room_for`], as an error building rows.
fn room_for_rows<T>(items: &mut Vec<T>) -> Result<(), Invalid> {
    if room_for(items) {
        Ok(())
    } else {
        Err(Invalid(
            "the export takes more than its budget to decode".to_owned(),
        ))
    }
}

/// A list for exactly `count` items, charged before it is allocated.
fn reserved<T>(count: usize) -> Result<Vec<T>, Invalid> {
    charge_rows(heap(count.saturating_mul(size_of::<T>())))?;
    Ok(Vec::with_capacity(count))
}

/// `text` as a string of its own, charged before it is copied. Text already unescaped from the
/// export is moved, not copied.
fn owned(text: Text<'_>) -> Result<String, Invalid> {
    match text {
        Cow::Borrowed(text) => {
            charge_rows(heap(text.len()))?;
            Ok(text.to_owned())
        }
        Cow::Owned(text) => Ok(text),
    }
}

/// Decode on this thread with `budget`: too large when it went over, whatever error that caused
/// on the way.
fn within<T>(
    budget: Budget,
    decode: impl FnOnce() -> Result<T, Invalid>,
) -> Result<T, Undecodable> {
    within_charged(budget, decode).0
}

/// `within`, and what decoding was charged.
fn within_charged<T>(
    budget: Budget,
    decode: impl FnOnce() -> Result<T, Invalid>,
) -> (Result<T, Undecodable>, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            BUDGET.with(|cell| cell.set(UNBOUNDED));
        }
    }
    let _reset = Reset;
    BUDGET.with(|cell| cell.set(budget));
    let result = decode();
    let spent = BUDGET.with(|cell| cell.get());
    if spent.over {
        return (Err(Undecodable::TooLarge), spent.peak);
    }
    (result.map_err(Undecodable::Invalid), spent.peak)
}

// --- Values of the wrong kind ------------------------------------------------------------
//
// serde_json, asked for an object, a list or a boolean, formats a string it finds instead into its
// error message whole: a 16 MiB string would make a 16 MiB message. So every place that expects
// an object, a list or a boolean takes any value and refuses another kind with a message of its
// own, quoting at most `EXCERPT_CHARS` of a string (`wrong_string`).

/// What a part of the export is, for a message.
trait Expected {
    const WHAT: &'static str;
    /// What a list of them is, naming its field where the list has one.
    const LIST: &'static str = Self::WHAT;
}

/// A string where something else was expected.
fn wrong_string<E: serde::de::Error>(expected: &str, text: &str) -> E {
    E::custom(format!(
        "expected {expected}, found the string {}",
        Excerpt(text)
    ))
}

/// A visitor's answer to a string where it expects something else.
macro_rules! refuse_strings {
    ($this:ident => $expected:expr) => {
        fn visit_str<E: serde::de::Error>($this, text: &str) -> Result<Self::Value, E> {
            Err(wrong_string($expected, text))
        }
        fn visit_borrowed_str<E: serde::de::Error>($this, text: &'de str) -> Result<Self::Value, E> {
            Err(wrong_string($expected, text))
        }
        fn visit_string<E: serde::de::Error>($this, text: String) -> Result<Self::Value, E> {
            Err(wrong_string($expected, &text))
        }
    };
    ($expected:expr) => {
        fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
            Err(wrong_string($expected, text))
        }
        fn visit_borrowed_str<E: serde::de::Error>(self, text: &'de str) -> Result<Self::Value, E> {
            Err(wrong_string($expected, text))
        }
        fn visit_string<E: serde::de::Error>(self, text: String) -> Result<Self::Value, E> {
            Err(wrong_string($expected, &text))
        }
    };
}

/// Reads an object of the export, as its derived `Deserialize` reads it, refusing a string
/// without quoting it whole.
struct Guard<T>(std::marker::PhantomData<T>);

impl<T> Clone for Guard<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Guard<T> {}

impl<T> Guard<T> {
    fn new() -> Self {
        Guard(std::marker::PhantomData)
    }
}

impl<'de, T: Deserialize<'de> + Expected> DeserializeSeed<'de> for Guard<T> {
    type Value = T;

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<T, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de, T: Deserialize<'de> + Expected> Visitor<'de> for Guard<T> {
    type Value = T;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str(T::WHAT)
    }

    fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<T, M::Error> {
        T::deserialize(serde::de::value::MapAccessDeserializer::new(map))
    }

    fn visit_seq<S: SeqAccess<'de>>(self, seq: S) -> Result<T, S::Error> {
        T::deserialize(serde::de::value::SeqAccessDeserializer::new(seq))
    }

    refuse_strings!(T::WHAT);
}

/// An object field of the export, read through a `Guard`.
struct Obj<T>(T);

impl<'de, T: Deserialize<'de> + Expected> Deserialize<'de> for Obj<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Guard::<T>::new().deserialize(deserializer).map(Obj)
    }
}

/// A `boolValue`.
struct Flag(bool);

impl<'de> Deserialize<'de> for Flag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FlagVisitor;
        impl<'de> Visitor<'de> for FlagVisitor {
            type Value = Flag;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a boolean")
            }
            fn visit_bool<E: serde::de::Error>(self, flag: bool) -> Result<Flag, E> {
                Ok(Flag(flag))
            }
            refuse_strings!("a boolean for boolValue");
        }
        deserializer.deserialize_any(FlagVisitor)
    }
}

/// A list of objects in an export, each read through a `Guard`, the list growing only as it is
/// charged. A short list is one allocation that doubles as it fills; once that reaches
/// `LIST_CHUNK_BYTES`, the list goes on in further chunks of that size, so a long list is never
/// copied as it grows and holds at most one chunk more than its items. (A list doubling as one
/// allocation held its old allocation beside the new one twice its size: 262,145 short logs took
/// 104 MB to hold 35 MB of records, and were refused.)
struct List<T> {
    chunks: Vec<Vec<T>>,
    len: usize,
}

/// The size of each chunk of a long `List`.
const LIST_CHUNK_BYTES: usize = 64 << 10;

impl<T> Default for List<T> {
    fn default() -> Self {
        List {
            chunks: Vec::new(),
            len: 0,
        }
    }
}

impl<T> List<T> {
    /// The most items one chunk holds.
    fn per_chunk() -> usize {
        (LIST_CHUNK_BYTES / size_of::<T>().max(1)).max(4)
    }

    fn len(&self) -> usize {
        self.len
    }

    fn iter(&self) -> impl Iterator<Item = &T> {
        self.chunks.iter().flatten()
    }

    /// What the list's allocations were charged, released once its items are taken.
    fn wire_bytes(&self) -> usize {
        heap(self.chunks.capacity() * size_of::<Vec<T>>())
            + self
                .chunks
                .iter()
                .map(|chunk| heap(chunk.capacity() * size_of::<T>()))
                .sum::<usize>()
    }

    /// Add `item`, charging any allocation first.
    fn push<E: serde::de::Error>(&mut self, item: T) -> Result<(), E> {
        let per_chunk = Self::per_chunk();
        match self.chunks.last_mut() {
            Some(last) if last.len() < per_chunk => {
                if !room_up_to(last, per_chunk) {
                    return Err(over_budget());
                }
            }
            full => {
                // A further chunk is made at its full size at once; the first starts small.
                let first = full.is_none();
                room::<Vec<T>, E>(&mut self.chunks)?;
                if first {
                    self.chunks.push(Vec::new());
                    let chunk = self.chunks.last_mut().expect("pushed");
                    if !room_up_to(chunk, per_chunk) {
                        return Err(over_budget());
                    }
                } else {
                    if !afford(heap(per_chunk * size_of::<T>())) {
                        return Err(over_budget());
                    }
                    self.chunks.push(Vec::with_capacity(per_chunk));
                }
            }
        }
        self.chunks.last_mut().expect("a chunk").push(item);
        self.len += 1;
        Ok(())
    }
}

impl<T> IntoIterator for List<T> {
    type Item = T;
    type IntoIter = std::iter::Flatten<std::vec::IntoIter<Vec<T>>>;
    fn into_iter(self) -> Self::IntoIter {
        self.chunks.into_iter().flatten()
    }
}

fn over_budget<E: serde::de::Error>() -> E {
    E::custom("the export takes more than its budget to decode")
}

impl<'de, T: Deserialize<'de> + Expected> Deserialize<'de> for List<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de> + Expected> Visitor<'de> for ListVisitor<T> {
            type Value = List<T>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(formatter, "a list of {}", T::LIST)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<List<T>, A::Error> {
                let mut items = List::default();
                while let Some(item) = seq.next_element_seed(Guard::<T>::new())? {
                    items.push::<A::Error>(item)?;
                }
                Ok(items)
            }
            refuse_strings!(self => &format!("a list of {}", T::LIST));
        }
        deserializer.deserialize_any(ListVisitor(std::marker::PhantomData))
    }
}

// --- The wire format -------------------------------------------------------------------------
//
// Strings borrow from the request body where they need no unescaping, so decoding allocates
// little beyond the rows it produces.

type Text<'a> = Cow<'a, str>;

/// A whole number, in any form ProtoJSON allows for an integer field: a JSON number or a string
/// holding one, with or without a fraction part or an exponent (`100`, `"100"`, `1e2`, `"1e2"`,
/// `"100.0"`, `"1000e-1"`), as long as its value is whole. Each field checks the range. `None`
/// is an empty string, which ProtoJSON calls invalid; timestamps keep Motel's reading of it as 0.
///
/// A string is read exactly. A number with a fraction part or exponent arrives as a double, so it
/// is exact only up to 2^53, as in any JSON reader that parses numbers as doubles.
struct Whole(Option<i128>);

impl<'de> Deserialize<'de> for Whole {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(WholeVisitor)
    }
}

struct WholeVisitor;

impl serde::de::Visitor<'_> for WholeVisitor {
    type Value = Whole;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a whole number, as a JSON number or a string")
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Whole, E> {
        Ok(Whole(Some(value.into())))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Whole, E> {
        Ok(Whole(Some(value.into())))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Whole, E> {
        // Every double this large is whole and outside every field's range.
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e38 {
            Ok(Whole(Some(value as i128)))
        } else {
            Err(E::custom(format!("{value} is not a whole number in range")))
        }
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Whole, E> {
        if value.is_empty() {
            return Ok(Whole(None));
        }
        whole_number(value)
            .map(|number| Whole(Some(number)))
            .ok_or_else(|| E::custom(format!("{} is not a whole number in range", Excerpt(value))))
    }
}

/// The exact value of a decimal number written as text, when it is whole: an optional sign, digits
/// with an optional fraction part, and an optional exponent. `None` when it is not a number, not
/// whole, or beyond `i128`.
pub fn whole_number(text: &str) -> Option<i128> {
    let (negative, rest) = match text.as_bytes().first()? {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let (whole_part, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole_part.is_empty() && fraction.is_empty())
        || !digits_only(whole_part)
        || !digits_only(fraction)
    {
        return None;
    }
    // The exponent, exactly, or 10^20 when it is larger. Every string is shorter than
    // usize::MAX < 10^20 bytes, so a larger exponent cannot be cancelled by the digits: it gives
    // the same answer as 10^20 (too large, or not whole unless the digits are all zero).
    let exponent: i128 = match exponent {
        None => 0,
        Some(exponent) => {
            let (sign, digits) = match exponent.as_bytes().first()? {
                b'-' => (-1, &exponent[1..]),
                b'+' => (1, &exponent[1..]),
                _ => (1, exponent),
            };
            if digits.is_empty() || !digits_only(digits) {
                return None;
            }
            let significant = digits.trim_start_matches('0');
            let magnitude: i128 = if significant.len() > 20 {
                10_i128.pow(20)
            } else {
                significant
                    .parse::<i128>()
                    .unwrap_or(0)
                    .min(10_i128.pow(20))
            };
            sign * magnitude
        }
    };
    // A copy of the digits, as long as the field: charged while an export decodes, and given
    // back when it is freed as this returns.
    let copy = heap(whole_part.len() + fraction.len());
    if !afford(copy) {
        return None;
    }
    struct Freed(usize);
    impl Drop for Freed {
        fn drop(&mut self) {
            release(self.0);
        }
    }
    let _freed = Freed(copy);
    let joined = format!("{whole_part}{fraction}");
    let significant = joined.trim_start_matches('0');
    if significant.is_empty() {
        return Some(0);
    }
    let shift = exponent - fraction.len() as i128;
    let magnitude: u128 = if shift < 0 {
        let cut = usize::try_from(-shift).ok()?;
        let keep = significant.len().checked_sub(cut)?;
        if !significant[keep..].bytes().all(|byte| byte == b'0') {
            return None;
        }
        significant[..keep].parse().ok()?
    } else {
        let zeros = usize::try_from(shift).ok()?;
        if significant.len() + zeros > 39 {
            return None;
        }
        format!("{significant}{}", "0".repeat(zeros)).parse().ok()?
    };
    let magnitude = i128::try_from(magnitude).ok()?;
    Some(if negative { -magnitude } else { magnitude })
}

/// A whole number in the range of `T`, or why the export is invalid.
fn in_range<T: TryFrom<i128>>(value: Option<i128>, field: &str) -> Result<T, Invalid> {
    value
        .and_then(|value| T::try_from(value).ok())
        .ok_or_else(|| Invalid(format!("{field} is empty or out of range")))
}

#[derive(Deserialize)]
struct KeyValue<'a> {
    #[serde(borrow)]
    key: Borrowed<'a>,
    /// Read as text here and decoded by [`parse`], so its depth does not count against the
    /// export's.
    #[serde(borrow)]
    value: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Resource<'a> {
    #[serde(borrow)]
    attributes: Option<List<KeyValue<'a>>>,
}

#[derive(Deserialize)]
struct Scope<'a> {
    #[serde(borrow)]
    name: Option<Borrowed<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceExport<'a> {
    #[serde(borrow)]
    resource_spans: Option<List<ResourceSpans<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSpans<'a> {
    #[serde(borrow)]
    resource: Option<Obj<Resource<'a>>>,
    #[serde(borrow)]
    scope_spans: Option<List<ScopeSpans<'a>>>,
}

#[derive(Deserialize)]
struct ScopeSpans<'a> {
    #[serde(borrow)]
    scope: Option<Obj<Scope<'a>>>,
    #[serde(borrow)]
    spans: Option<List<Span<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span<'a> {
    #[serde(borrow)]
    trace_id: Borrowed<'a>,
    #[serde(borrow)]
    span_id: Borrowed<'a>,
    #[serde(borrow)]
    parent_span_id: Option<Borrowed<'a>>,
    #[serde(borrow)]
    name: Option<Borrowed<'a>>,
    kind: Option<Whole>,
    start_time_unix_nano: Option<Whole>,
    end_time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    attributes: Option<List<KeyValue<'a>>>,
    status: Option<Obj<Status>>,
    #[serde(borrow)]
    events: Option<Events<'a>>,
}

/// The most events a span keeps: the first ones, in the export's order. The rest are skipped
/// without being built, and counted (`SpanRow::events_dropped`), so what one span holds on read
/// does not grow with the export (Motel kept every event).
pub const EVENT_LIMIT: usize = 128;

/// A span's events, at most [`EVENT_LIMIT`] of them, and how many more the export had.
#[derive(Default)]
struct Events<'a> {
    kept: Vec<Event<'a>>,
    dropped: u64,
}

impl<'de: 'a, 'a> Deserialize<'de> for Events<'a> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(EventsVisitor(std::marker::PhantomData))
    }
}

struct EventsVisitor<'a>(std::marker::PhantomData<&'a ()>);

impl<'de: 'a, 'a> Visitor<'de> for EventsVisitor<'a> {
    type Value = Events<'a>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a list of events")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut events: A) -> Result<Events<'a>, A::Error> {
        let mut kept = Vec::new();
        while kept.len() < EVENT_LIMIT {
            match events.next_element_seed(Guard::<Event<'a>>::new())? {
                Some(event) => {
                    room::<Event, A::Error>(&mut kept)?;
                    kept.push(event);
                }
                None => return Ok(Events { kept, dropped: 0 }),
            }
        }
        // Read past, as JSON only: an event not kept is not decoded or checked.
        let mut dropped = 0;
        while events.next_element::<IgnoredAny>()?.is_some() {
            dropped += 1;
        }
        Ok(Events { kept, dropped })
    }

    refuse_strings!("a list of events");
}

#[derive(Deserialize)]
struct Status {
    code: Option<Whole>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    name: Option<Borrowed<'a>>,
    #[serde(borrow)]
    attributes: Option<List<KeyValue<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogExport<'a> {
    #[serde(borrow)]
    resource_logs: Option<List<ResourceLogs<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLogs<'a> {
    #[serde(borrow)]
    resource: Option<Obj<Resource<'a>>>,
    #[serde(borrow)]
    scope_logs: Option<List<ScopeLogs<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeLogs<'a> {
    #[serde(borrow)]
    scope: Option<Obj<Scope<'a>>>,
    #[serde(borrow)]
    log_records: Option<List<LogRecord<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogRecord<'a> {
    time_unix_nano: Option<Whole>,
    observed_time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    severity_text: Option<Borrowed<'a>>,
    #[serde(borrow)]
    body: Option<&'a RawValue>,
    #[serde(borrow)]
    attributes: Option<List<KeyValue<'a>>>,
    #[serde(borrow)]
    trace_id: Option<Borrowed<'a>>,
    #[serde(borrow)]
    span_id: Option<Borrowed<'a>>,
}

impl Expected for KeyValue<'_> {
    const WHAT: &'static str = "an attribute (a KeyValue object)";
    const LIST: &'static str = "attributes (KeyValue objects)";
}
impl Expected for Resource<'_> {
    const WHAT: &'static str = "a resource (an object)";
}
impl Expected for Scope<'_> {
    const WHAT: &'static str = "a scope (an object)";
}
impl Expected for TraceExport<'_> {
    const WHAT: &'static str = "a traces export (an object)";
}
impl Expected for ResourceSpans<'_> {
    const WHAT: &'static str = "resourceSpans entries (objects)";
}
impl Expected for ScopeSpans<'_> {
    const WHAT: &'static str = "scopeSpans entries (objects)";
}
impl Expected for Span<'_> {
    const WHAT: &'static str = "spans (objects)";
}
impl Expected for Status {
    const WHAT: &'static str = "a span's status (an object)";
}
impl Expected for Event<'_> {
    const WHAT: &'static str = "events (objects)";
}
impl Expected for LogExport<'_> {
    const WHAT: &'static str = "a logs export (an object)";
}
impl Expected for ResourceLogs<'_> {
    const WHAT: &'static str = "resourceLogs entries (objects)";
}
impl Expected for ScopeLogs<'_> {
    const WHAT: &'static str = "scopeLogs entries (objects)";
}
impl Expected for LogRecord<'_> {
    const WHAT: &'static str = "log records (objects)";
}

// --- What the store keeps --------------------------------------------------------------------

/// A resource: its attributes as canonical JSON (sorted keys, compact) and its service name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRow {
    pub attributes_json: String,
    pub service_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanRow {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent_span_id: Option<[u8; 8]>,
    pub scope_name: Option<String>,
    pub name: String,
    /// 1 to 5; any other kind is stored as unknown.
    pub kind: Option<i64>,
    pub start_ns: i64,
    pub end_ns: i64,
    /// 1 when the span's status code is error (2), otherwise 0.
    pub status: i64,
    /// The span's own attributes as canonical JSON.
    pub attributes_json: String,
    /// `[{name, timeNs, attributes}]`, or none when the span has no events. At most
    /// [`EVENT_LIMIT`] events.
    pub events_json: Option<String>,
    /// Events the export had past [`EVENT_LIMIT`], not stored.
    pub events_dropped: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRow {
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub scope_name: Option<String>,
    pub severity_text: String,
    pub time_ns: i64,
    pub body: String,
    pub attributes_json: String,
}

/// The spans of one export, grouped by resource.
#[derive(Debug, Default)]
pub struct Spans {
    pub groups: Vec<(ResourceRow, Vec<SpanRow>)>,
    /// Events dropped from its spans past [`EVENT_LIMIT`], in all.
    pub events_dropped: u64,
}

/// The log records of one export, grouped by resource.
#[derive(Debug, Default)]
pub struct Logs {
    pub groups: Vec<(ResourceRow, Vec<LogRow>)>,
}

/// Decode a `/v1/traces` body, with no budget.
pub fn decode_spans(body: &[u8]) -> Result<Spans, Invalid> {
    within(UNBOUNDED, || decode_spans_body(body)).map_err(unbudgeted)
}

/// Decode a `/v1/logs` body, with no budget.
pub fn decode_logs(body: &[u8]) -> Result<Logs, Invalid> {
    within(UNBOUNDED, || decode_logs_body(body)).map_err(unbudgeted)
}

/// The budget of an export under a size limit of `limit` bytes: `DECODE_SHARE` times it, and rows
/// of at most `ROW_SHARE` times it of text.
fn budget(limit: usize) -> Budget {
    Budget {
        left: DECODE_SHARE.saturating_mul(limit),
        over: false,
        row_bytes: ROW_SHARE.saturating_mul(limit),
        charged: 0,
        peak: 0,
    }
}

/// `decode_spans_within`, and the most decoding held charged at once: for the tests that
/// measure what decoding holds against what it was charged.
pub fn decode_spans_charged(body: &[u8], limit: usize) -> (Result<Spans, Undecodable>, usize) {
    within_charged(budget(limit), || decode_spans_body(body))
}

/// `decode_logs_within`, and the bytes decoding was charged.
pub fn decode_logs_charged(body: &[u8], limit: usize) -> (Result<Logs, Undecodable>, usize) {
    within_charged(budget(limit), || decode_logs_body(body))
}

fn unbudgeted(undecodable: Undecodable) -> Invalid {
    match undecodable {
        Undecodable::Invalid(invalid) => invalid,
        Undecodable::TooLarge => {
            Invalid("the export takes more than its budget to decode".to_owned())
        }
    }
}

/// Decode a `/v1/traces` body under a size limit of `limit` bytes: charged at most
/// `DECODE_SHARE` times it, each row's text at most `ROW_SHARE` times it.
pub fn decode_spans_within(body: &[u8], limit: usize) -> Result<Spans, Undecodable> {
    within(budget(limit), || decode_spans_body(body))
}

/// Decode a `/v1/logs` body under a size limit of `limit` bytes, as `decode_spans_within`.
pub fn decode_logs_within(body: &[u8], limit: usize) -> Result<Logs, Undecodable> {
    within(budget(limit), || decode_logs_body(body))
}

/// An export's whole body, through a `Guard`, with what its reader keeps for skipped values
/// charged first.
fn read_export<'de, T: Deserialize<'de> + Expected>(body: &'de [u8]) -> Result<T, Export> {
    let skipped = skip_scratch(body);
    charge_rows(skipped).map_err(Export::Budget)?;
    let mut reader = serde_json::Deserializer::from_slice(body);
    let export = Guard::<T>::new()
        .deserialize(&mut reader)
        .and_then(|export| reader.end().map(|()| export))
        .map_err(Export::Json)?;
    release(skipped);
    Ok(export)
}

/// Why an export's body was not read.
enum Export {
    Budget(Invalid),
    Json(serde_json::Error),
}

/// What a serde_json reader keeps while it skips a value (an unknown field, or a raw value it
/// passes on): a byte for each bracket open around the place it has reached, in a buffer that
/// doubles as it grows and stays for the reader's life. A field nested 450,000 deep kept 786 KB.
/// Charged from the deepest nesting in `json`, outside strings (a bracket in a string opens
/// nothing, and a closing one there must not hide real depth): the buffer and the one it grew
/// from, at most twice the next power of two.
fn skip_scratch(json: &[u8]) -> usize {
    let (mut open, mut deepest) = (0usize, 0usize);
    let (mut in_string, mut escaped) = (false, false);
    for &byte in json {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                open += 1;
                deepest = deepest.max(open);
            }
            b']' | b'}' => open = open.saturating_sub(1),
            _ => {}
        }
    }
    if deepest == 0 {
        0
    } else {
        heap(2 * deepest.next_power_of_two())
    }
}

/// What a message about an export says, in this order, so a long value never pushes out the
/// rest: where (line and column), then what was expected and what was found, at most
/// `EXCERPT_CHARS` of a value. serde_json puts the place at the end of its message; it is moved.
fn export_error(signal: &str, error: &serde_json::Error) -> Invalid {
    Invalid(placed(&format!("Invalid {signal} export"), error))
}

/// `what` at the error's line and column, then its message without them.
fn placed(what: &str, error: &serde_json::Error) -> String {
    let (line, column) = (error.line(), error.column());
    let text = error.to_string();
    let message = text
        .strip_suffix(&format!(" at line {line} column {column}"))
        .unwrap_or(&text);
    if line == 0 {
        format!("{what}: {message}")
    } else {
        format!("{what} at line {line} column {column}: {message}")
    }
}

fn decode_spans_body(body: &[u8]) -> Result<Spans, Invalid> {
    let export: TraceExport = read_export(body).map_err(|error| match error {
        Export::Budget(invalid) => invalid,
        Export::Json(error) => export_error("traces", &error),
    })?;
    let mut out = Spans::default();
    let resources = export.resource_spans.unwrap_or_default();
    out.groups = reserved(resources.len())?;
    for resource_spans in resources {
        let resource = resource_row(resource_spans.resource.map(|resource| resource.0))?;
        let scopes = resource_spans.scope_spans.unwrap_or_default();
        // As many rows as the wire lists hold: reserved once, at that size.
        let mut rows = reserved(
            scopes
                .iter()
                .map(|scope| scope.spans.as_ref().map_or(0, List::len))
                .sum(),
        )?;
        for scope_spans in scopes {
            let scope_name = match scope_spans.scope.and_then(|scope| scope.0.name) {
                Some(name) => {
                    short_name("A scope's name", &name)?;
                    Some(owned(name.0)?)
                }
                None => None,
            };
            let spans = scope_spans.spans.unwrap_or_default();
            let wire = spans.wire_bytes();
            for span in spans {
                // Each row keeps its own copy of the scope's name, as stored.
                charge_rows(scope_name.as_ref().map_or(0, |name| heap(name.len())))?;
                let row = span_row(span, scope_name.clone())?;
                out.events_dropped += row.events_dropped;
                rows.push(row);
            }
            release(wire);
        }
        out.groups.push((resource, rows));
    }
    Ok(out)
}

fn decode_logs_body(body: &[u8]) -> Result<Logs, Invalid> {
    let export: LogExport = read_export(body).map_err(|error| match error {
        Export::Budget(invalid) => invalid,
        Export::Json(error) => export_error("logs", &error),
    })?;
    let mut out = Logs::default();
    let resources = export.resource_logs.unwrap_or_default();
    out.groups = reserved(resources.len())?;
    for resource_logs in resources {
        let resource = resource_row(resource_logs.resource.map(|resource| resource.0))?;
        let scopes = resource_logs.scope_logs.unwrap_or_default();
        let mut rows = reserved(
            scopes
                .iter()
                .map(|scope| scope.log_records.as_ref().map_or(0, List::len))
                .sum(),
        )?;
        for scope_logs in scopes {
            let scope_name = match scope_logs.scope.and_then(|scope| scope.0.name) {
                Some(name) => {
                    short_name("A scope's name", &name)?;
                    Some(owned(name.0)?)
                }
                None => None,
            };
            let records = scope_logs.log_records.unwrap_or_default();
            let wire = records.wire_bytes();
            for record in records {
                charge_rows(scope_name.as_ref().map_or(0, |name| heap(name.len())))?;
                let row = log_row(record, scope_name.clone())?;
                rows.push(row);
            }
            release(wire);
        }
        out.groups.push((resource, rows));
    }
    Ok(out)
}

fn resource_row(resource: Option<Resource<'_>>) -> Result<ResourceRow, Invalid> {
    let attributes = attribute_map(resource.and_then(|resource| resource.attributes))?;
    for key in ["service.name", "service_name"] {
        if let Some(name) = lookup(&attributes, key) {
            short_name("A resource's service name", name)?;
        }
    }
    let service_name = owned(Cow::Borrowed(
        [
            lookup(&attributes, "service.name"),
            lookup(&attributes, "service_name"),
        ]
        .into_iter()
        .flatten()
        .find(|name| !name.is_empty())
        .map_or("unknown", |name| name.as_ref()),
    ))?;
    let attributes_json = canonical_json(attributes)?;
    row_fits(attributes_json.len() + service_name.len())?;
    Ok(ResourceRow {
        attributes_json,
        service_name,
    })
}

fn span_row(span: Span<'_>, scope_name: Option<String>) -> Result<SpanRow, Invalid> {
    let trace_id = binary_id::<16>(&span.trace_id)
        .ok_or_else(|| Invalid(format!("Invalid trace id {}", Excerpt(&span.trace_id))))?;
    let span_id = binary_id::<8>(&span.span_id)
        .ok_or_else(|| Invalid(format!("Invalid span id {}", Excerpt(&span.span_id))))?;
    let parent_span_id = match span.parent_span_id.as_deref() {
        None | Some("") => None,
        Some(parent) => Some(
            binary_id::<8>(parent)
                .ok_or_else(|| Invalid(format!("Invalid parent span id {}", Excerpt(parent))))?,
        ),
    };
    let Events {
        kept: events,
        dropped: events_dropped,
    } = span.events.unwrap_or_default();
    let events_json = if events.is_empty() {
        None
    } else {
        Some(events_json(events)?)
    };
    if let Some(name) = &span.name {
        short_name("A span's name", name)?;
    }
    let name = owned(span.name.map_or(Cow::Borrowed("unknown"), |name| name.0))?;
    let attributes_json = canonical_json(attribute_map(span.attributes)?)?;
    row_fits(
        name.len()
            + attributes_json.len()
            + events_json.as_ref().map_or(0, String::len)
            + scope_name.as_ref().map_or(0, String::len),
    )?;
    Ok(SpanRow {
        trace_id,
        span_id,
        parent_span_id,
        scope_name,
        name,
        kind: match span.kind {
            Some(kind) => Some(i64::from(in_range::<i32>(kind.0, "kind")?))
                .filter(|kind| (1..=5).contains(kind)),
            None => None,
        },
        start_ns: nanos(span.start_time_unix_nano)?,
        end_ns: nanos(span.end_time_unix_nano)?,
        status: match span.status.and_then(|status| status.0.code) {
            Some(code) => i64::from(in_range::<i32>(code.0, "status code")? == 2),
            None => 0,
        },
        attributes_json,
        events_json,
        events_dropped,
    })
}

fn log_row(record: LogRecord<'_>, scope_name: Option<String>) -> Result<LogRow, Invalid> {
    let attributes = attribute_map(record.attributes)?;
    let from_attributes = |keys: [&str; 2]| {
        keys.iter()
            .filter_map(|key| lookup(&attributes, key))
            .find(|value| !value.is_empty())
            .map(|value| value.as_ref())
    };
    let trace_id = from_attributes(["traceId", "trace_id"])
        .or(record.trace_id.as_deref())
        .and_then(binary_id::<16>);
    let span_id = from_attributes(["spanId", "span_id"])
        .or(record.span_id.as_deref())
        .and_then(binary_id::<8>);
    let time_ns = match nanos(record.time_unix_nano)? {
        0 => nanos(record.observed_time_unix_nano)?,
        time => time,
    };
    if let Some(severity) = &record.severity_text {
        short_name("A log's severity", severity)?;
    }
    let severity_text = owned(
        record
            .severity_text
            .map_or(Cow::Borrowed("INFO"), |text| text.0),
    )?;
    let body = match record.body {
        Some(body) => owned(stringify(parse(body)?)?)?,
        None => String::new(),
    };
    let attributes_json = canonical_json(attributes)?;
    row_fits(
        severity_text.len()
            + body.len()
            + attributes_json.len()
            + scope_name.as_ref().map_or(0, String::len),
    )?;
    Ok(LogRow {
        trace_id,
        span_id,
        scope_name,
        severity_text,
        time_ns,
        body,
        attributes_json,
    })
}

/// A count of nanoseconds since the epoch. Missing is 0, as in Motel.
/// A count of nanoseconds since the epoch: an unsigned 64-bit field, stored as a signed one.
/// Missing or empty is 0, as in Motel.
fn nanos(value: Option<Whole>) -> Result<i64, Invalid> {
    match value {
        None | Some(Whole(None)) => Ok(0),
        Some(Whole(Some(nanos))) => i64::try_from(nanos)
            .ok()
            .filter(|nanos| *nanos >= 0)
            .ok_or_else(|| Invalid(format!("Time {nanos} is out of range"))),
    }
}

// --- Attribute values ------------------------------------------------------------------------

/// An `AnyValue` after Motel's `parseAnyValue`, before it is made a string.
#[derive(Debug, PartialEq)]
enum Value<'a> {
    Null,
    Text(Text<'a>),
    Bool(bool),
    /// Decimal digits of an `intValue`, kept exactly.
    Int(String),
    Double(f64),
    Array(Vec<Value<'a>>),
    /// Entries in the order JavaScript's `Object.fromEntries` keeps: first position, last value.
    Object(Vec<(Text<'a>, Value<'a>)>),
}

/// How many arrays and key-value lists deep a value is decoded. A value inside more of them than
/// this is kept as its `AnyValue`'s JSON text, exactly as the export spelled it, in the place its
/// value would have had.
///
/// Decoding a value recurses once per level, in serde_json and here, and so do making it a string
/// and dropping it. Values decode on the runtime's blocking threads, which `main` gives
/// `DECODE_STACK` of stack. Measured on x86-64 Linux, a value inside 64 key-value lists needs about
/// 91 KiB in a release build and 544 KiB in a debug build (arrays: 91 KiB and 410 KiB); each level
/// adds about 1.3 KiB and 8.2 KiB. The tests decode values at and past this depth on a 1 MiB
/// thread. Text past the limit is read without recursion (serde_json keeps one byte per open
/// bracket), so its depth is bounded only by the export's size, and costs no stack.
///
/// The pinned Effect exporter writes nested user data as nested values; 40 levels of arrays is
/// 1,315 bytes.
pub const VALUE_DEPTH: usize = 64;

/// The stack of every thread that decodes an export. The runtime is built with it, so it does not
/// depend on `RUST_MIN_STACK`: with 64 KiB there, a value 64 key-value lists deep overflowed the
/// stack and ended the process.
pub const DECODE_STACK: usize = 2 * 1024 * 1024;

/// Decode one attribute value or log body, as Motel's `parseAnyValue` read it.
///
/// The export's reader keeps the value as text, which serde_json reads without recursion, and keeps
/// its own 128-level limit for everything else. The value then gets its own reader, with
/// serde_json's limit (128 levels of JSON, about 40 levels of arrays) off: the only recursion in it
/// is through [`AnyValueSeed`], which stops at [`VALUE_DEPTH`]. Every other field it reads is a
/// scalar, and a field it skips is read without recursion.
fn parse(value: &RawValue) -> Result<Value<'_>, Invalid> {
    let skipped = skip_scratch(value.get().as_bytes());
    charge_rows(skipped)?;
    let mut reader = serde_json::Deserializer::from_str(value.get());
    reader.disable_recursion_limit();
    let parsed = AnyValueSeed { depth: 0 }
        .deserialize(&mut reader)
        .and_then(|parsed| reader.end().map(|()| parsed))
        .map_err(|error| Invalid(placed("Invalid attribute value or log body", &error)))?;
    release(skipped);
    Ok(parsed)
}

/// The names of the fields an `AnyValue`, an array or a key-value list has; anything else is
/// skipped.
enum Field {
    StringValue,
    BoolValue,
    IntValue,
    DoubleValue,
    BytesValue,
    ArrayValue,
    KvlistValue,
    Values,
    Key,
    Value,
    Other,
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;
        impl Visitor<'_> for FieldVisitor {
            type Value = Field;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a field name")
            }
            fn visit_str<E: serde::de::Error>(self, name: &str) -> Result<Field, E> {
                Ok(match name {
                    "stringValue" => Field::StringValue,
                    "boolValue" => Field::BoolValue,
                    "intValue" => Field::IntValue,
                    "doubleValue" => Field::DoubleValue,
                    "bytesValue" => Field::BytesValue,
                    "arrayValue" => Field::ArrayValue,
                    "kvlistValue" => Field::KvlistValue,
                    "values" => Field::Values,
                    "key" => Field::Key,
                    "value" => Field::Value,
                    _ => Field::Other,
                })
            }
        }
        deserializer.deserialize_identifier(FieldVisitor)
    }
}

/// A string of the export: borrowed from it when it needs no unescaping, else unescaped into a
/// string of its own, charged. serde's own `Cow` borrows only where a field is written as `Cow`,
/// not through an alias or inside an `Option`, so every string goes through this.
struct Borrowed<'a>(Text<'a>);

impl std::ops::Deref for Borrowed<'_> {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl<'de: 'a, 'a> Deserialize<'de> for Borrowed<'a> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrVisitor<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for StrVisitor<'a> {
            type Value = Borrowed<'a>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string")
            }
            fn visit_borrowed_str<E: serde::de::Error>(
                self,
                text: &'de str,
            ) -> Result<Self::Value, E> {
                Ok(Borrowed(Cow::Borrowed(text)))
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
                charge::<E>(heap(text.len()))?;
                Ok(Borrowed(Cow::Owned(text.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(self, text: String) -> Result<Self::Value, E> {
                charge::<E>(heap(text.capacity()))?;
                Ok(Borrowed(Cow::Owned(text)))
            }
        }
        deserializer.deserialize_str(StrVisitor(std::marker::PhantomData))
    }
}

/// Store `value` in `slot`, refusing a field given twice as a derived struct does.
fn once<T, E: serde::de::Error>(
    slot: &mut Option<T>,
    value: T,
    name: &'static str,
) -> Result<(), E> {
    if slot.is_some() {
        return Err(E::duplicate_field(name));
    }
    *slot = Some(value);
    Ok(())
}

/// Reads an `AnyValue` inside `depth` arrays and key-value lists into a [`Value`].
#[derive(Clone, Copy)]
struct AnyValueSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for AnyValueSeed {
    type Value = Value<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Value<'de>, D::Error> {
        if self.depth > VALUE_DEPTH {
            // serde_json reads a raw value with a loop and a byte per open bracket, not recursion.
            let text = <&RawValue>::deserialize(deserializer)?;
            return Ok(Value::Text(Cow::Borrowed(text.get())));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for AnyValueSeed {
    type Value = Value<'de>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an AnyValue object")
    }

    refuse_strings!("an AnyValue object");

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Value<'de>, M::Error> {
        let mut string_value = None;
        let mut bool_value = None;
        let mut int_value = None;
        let mut double_value = None;
        let mut bytes_value = None;
        let mut array_value = None;
        let mut kvlist_value = None;
        let inner = ListSeed {
            depth: self.depth + 1,
            entries: false,
        };
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::StringValue => {
                    let text = map.next_value::<Option<Borrowed>>()?;
                    once(&mut string_value, text, "stringValue")?;
                }
                Field::BoolValue => {
                    let flag = map.next_value::<Option<Flag>>()?.map(|flag| flag.0);
                    once(&mut bool_value, flag, "boolValue")?;
                }
                Field::IntValue => {
                    let int = map.next_value::<Option<Whole>>()?;
                    once(&mut int_value, int, "intValue")?;
                }
                Field::DoubleValue => {
                    let double = map.next_value::<Option<Double>>()?;
                    once(&mut double_value, double, "doubleValue")?;
                }
                Field::BytesValue => {
                    let bytes = map.next_value::<Option<Borrowed>>()?;
                    once(&mut bytes_value, bytes, "bytesValue")?;
                }
                Field::ArrayValue => {
                    let array = map.next_value_seed(OptionSeed(inner))?;
                    once(&mut array_value, array, "arrayValue")?;
                }
                Field::KvlistValue => {
                    let list = map.next_value_seed(OptionSeed(ListSeed {
                        entries: true,
                        ..inner
                    }))?;
                    once(&mut kvlist_value, list, "kvlistValue")?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        // Motel's order: the first field that is set wins.
        if let Some(Borrowed(text)) = string_value.flatten() {
            return Ok(Value::Text(text));
        }
        if let Some(flag) = bool_value.flatten() {
            return Ok(Value::Bool(flag));
        }
        if let Some(int) = int_value.flatten() {
            // At most 20 digits and a sign, in a string of their own.
            charge::<M::Error>(heap(21))?;
            return in_range::<i64>(int.0, "intValue")
                .map(|int| Value::Int(int.to_string()))
                .map_err(|Invalid(message)| serde::de::Error::custom(message));
        }
        if let Some(Double(double)) = double_value.flatten() {
            return Ok(Value::Double(double));
        }
        if let Some(Borrowed(bytes)) = bytes_value.flatten() {
            return Ok(Value::Text(bytes));
        }
        if let Some(Some(list)) = array_value.flatten() {
            return Ok(list);
        }
        if let Some(Some(list)) = kvlist_value.flatten() {
            return Ok(list);
        }
        Ok(Value::Null)
    }
}

/// `null` or what `T` reads.
struct OptionSeed<T>(T);

impl<'de, T: DeserializeSeed<'de> + Copy> DeserializeSeed<'de> for OptionSeed<T> {
    type Value = Option<T::Value>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_option(self)
    }
}

impl<'de, T: DeserializeSeed<'de> + Copy> Visitor<'de> for OptionSeed<T> {
    type Value = Option<T::Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("null or a value")
    }

    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_some<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.0.deserialize(deserializer).map(Some)
    }
}

/// Reads an `ArrayValue` or a `KeyValueList` (`{"values": [...]}`) whose entries are inside
/// `depth` of them. `None` when it has no `values`, which Motel read as null.
#[derive(Clone, Copy)]
struct ListSeed {
    depth: usize,
    entries: bool,
}

impl<'de> DeserializeSeed<'de> for ListSeed {
    type Value = Option<Value<'de>>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ListSeed {
    type Value = Option<Value<'de>>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str(if self.entries {
            "a KeyValueList object"
        } else {
            "an ArrayValue object"
        })
    }

    refuse_strings!(self => if self.entries {
        "a KeyValueList object"
    } else {
        "an ArrayValue object"
    });

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut values = None;
        while let Some(field) = map.next_key::<Field>()? {
            if let Field::Values = field {
                let list = map.next_value_seed(OptionSeed(Entries(self)))?;
                once(&mut values, list, "values")?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(values.flatten())
    }
}

/// The `values` of a [`ListSeed`].
#[derive(Clone, Copy)]
struct Entries(ListSeed);

impl<'de> DeserializeSeed<'de> for Entries {
    type Value = Value<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Value<'de>, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Entries {
    type Value = Value<'de>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a list of values")
    }

    refuse_strings!("a list of values");

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<Value<'de>, S::Error> {
        let seed = AnyValueSeed {
            depth: self.0.depth,
        };
        if !self.0.entries {
            let mut values = Vec::new();
            while let Some(value) = seq.next_element_seed(seed)? {
                room::<Value, S::Error>(&mut values)?;
                values.push(value);
            }
            return Ok(Value::Array(values));
        }
        let mut object: Vec<(Text, Value)> = Vec::new();
        // Each key's place in `object`, so a repeated key is found without a scan. The table
        // grows only as it is charged, as `room_for` grows a list.
        let mut places: HashMap<Text, usize> = HashMap::new();
        while let Some((key, value)) = seq.next_element_seed(EntrySeed(seed))? {
            match places.get(&key) {
                Some(&place) => object[place].1 = value,
                None => {
                    if places.len() == places.capacity() {
                        let grown = places.capacity().saturating_mul(2).max(4);
                        let entry = size_of::<(Text, usize)>();
                        let old = table_bytes(places.capacity(), entry);
                        charge::<S::Error>(table_bytes(grown, entry))?;
                        places.reserve(grown - places.len());
                        release(old);
                    }
                    // The place's copy of the key is a copy only when the key was unescaped.
                    if let Cow::Owned(text) = &key {
                        charge::<S::Error>(heap(text.len()))?;
                    }
                    places.insert(key.clone(), object.len());
                    room::<(Text, Value), S::Error>(&mut object)?;
                    object.push((key, value));
                }
            }
        }
        // The table and its copies of keys are freed as this returns.
        release(table_bytes(places.capacity(), size_of::<(Text, usize)>()));
        release(
            places
                .keys()
                .map(|key| match key {
                    Cow::Owned(text) => heap(text.len()),
                    Cow::Borrowed(_) => 0,
                })
                .sum(),
        );
        Ok(Value::Object(object))
    }
}

/// One `KeyValue` of a key-value list: its key and its value, null when it has none.
#[derive(Clone, Copy)]
struct EntrySeed(AnyValueSeed);

impl<'de> DeserializeSeed<'de> for EntrySeed {
    type Value = (Text<'de>, Value<'de>);

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for EntrySeed {
    type Value = (Text<'de>, Value<'de>);

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a KeyValue object")
    }

    refuse_strings!("a KeyValue object");

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut key = None;
        let mut value = None;
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::Key => {
                    let Borrowed(text) = map.next_value()?;
                    once(&mut key, text, "key")?;
                }
                Field::Value => {
                    let parsed = map.next_value_seed(OptionSeed(self.0))?;
                    once(&mut value, parsed, "value")?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let key: Text = key.ok_or_else(|| serde::de::Error::missing_field("key"))?;
        if key.len() > NAME_BYTES {
            return Err(serde::de::Error::custom(format!(
                "a key in a key-value list is {} bytes; a name may be at most {NAME_BYTES}",
                key.len()
            )));
        }
        Ok((key, value.flatten().unwrap_or(Value::Null)))
    }
}

/// A `doubleValue`. ProtoJSON writes a double as a number, or as a string: `"NaN"`,
/// `"Infinity"`, `"-Infinity"` or a decimal number in quotes.
struct Double(f64);

impl<'de> Deserialize<'de> for Double {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DoubleVisitor)
    }
}

struct DoubleVisitor;

impl Visitor<'_> for DoubleVisitor {
    type Value = Double;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a double, as a JSON number or a string")
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Double, E> {
        Ok(Double(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Double, E> {
        Ok(Double(value as f64))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Double, E> {
        Ok(Double(value as f64))
    }

    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Double, E> {
        let invalid = || E::custom(format!("Invalid doubleValue {}", Excerpt(text)));
        Ok(Double(match text {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            // Rust's parser also takes words such as "inf"; ProtoJSON allows only digits.
            digits
                if digits
                    .bytes()
                    .any(|byte| byte.is_ascii_alphabetic() && byte != b'e' && byte != b'E') =>
            {
                return Err(invalid());
            }
            digits => digits.parse::<f64>().map_err(|_| invalid())?,
        }))
    }
}

/// Motel's `stringifyValue`: how an attribute value is stored and shown.
fn stringify(value: Value<'_>) -> Result<Text<'_>, Invalid> {
    Ok(match value {
        Value::Null => Cow::Borrowed(""),
        Value::Text(text) => text,
        Value::Bool(flag) => Cow::Borrowed(if flag { "true" } else { "false" }),
        Value::Int(digits) => Cow::Owned(digits),
        Value::Double(double) => {
            let number = js_number(double);
            charge_rows(heap(number.len()))?;
            Cow::Owned(number)
        }
        nested => {
            // Its length first, so the text is allocated once, at its size, after it is charged.
            let length = text_length(&nested);
            charge_rows(heap(length))?;
            let mut text = String::with_capacity(length);
            write_text(&mut text, &nested);
            // The tree is freed as this returns.
            release(tree_bytes(&nested));
            Cow::Owned(text)
        }
    })
}

/// What a value's tree was charged: its lists and its integers' digits.
fn tree_bytes(value: &Value<'_>) -> usize {
    match value {
        Value::Int(_) => heap(21),
        Value::Array(values) => {
            heap(values.capacity() * size_of::<Value>())
                + values.iter().map(tree_bytes).sum::<usize>()
        }
        Value::Object(entries) => {
            heap(entries.capacity() * size_of::<(Text, Value)>())
                + entries
                    .iter()
                    .map(|(_, entry)| tree_bytes(entry))
                    .sum::<usize>()
        }
        _ => 0,
    }
}

/// The length of what `write_text` writes for `value`.
fn text_length(value: &Value<'_>) -> usize {
    match value {
        Value::Null => 0,
        Value::Text(text) => text.len(),
        Value::Bool(flag) => {
            if *flag {
                4
            } else {
                5
            }
        }
        Value::Int(digits) => digits.len(),
        Value::Double(double) => js_number(*double).len(),
        Value::Array(values) => {
            let (mut length, mut wrote) = (0, false);
            for entry in values {
                let entry = text_length(entry);
                if entry > 0 {
                    length += entry + usize::from(wrote);
                    wrote = true;
                }
            }
            length
        }
        Value::Object(_) => json_length(value),
    }
}

/// The length of what `write_json` writes for `value`.
fn json_length(value: &Value<'_>) -> usize {
    match value {
        Value::Null => 4,
        Value::Text(text) => string_length(text),
        Value::Bool(flag) => {
            if *flag {
                4
            } else {
                5
            }
        }
        Value::Int(digits) => digits.len(),
        Value::Double(double) if double.is_finite() => js_number(*double).len(),
        Value::Double(_) => 4,
        Value::Array(values) => {
            2 + values.iter().map(json_length).sum::<usize>() + values.len().saturating_sub(1)
        }
        Value::Object(entries) => {
            2 + entries
                .iter()
                .map(|(key, entry)| string_length(key) + 1 + json_length(entry))
                .sum::<usize>()
                + entries.len().saturating_sub(1)
        }
    }
}

/// The length of `text` as a JSON string, escaped as serde_json escapes it.
fn string_length(text: &str) -> usize {
    2 + text
        .bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | 0x0c | b'\n' | b'\r' | b'\t' => 2,
            0x00..=0x1f => 6,
            _ => 1,
        })
        .sum::<usize>()
}

/// `stringify`, written into one buffer, so nested arrays are not copied once per level. An
/// array's non-empty entries are joined with a space.
fn write_text(out: &mut String, value: &Value<'_>) {
    match value {
        Value::Null => {}
        Value::Text(text) => out.push_str(text),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int(digits) => out.push_str(digits),
        Value::Double(double) => out.push_str(&js_number(*double)),
        Value::Array(values) => {
            let mut wrote = false;
            for entry in values {
                let mark = out.len();
                if wrote {
                    out.push(' ');
                }
                let start = out.len();
                write_text(out, entry);
                if out.len() == start {
                    out.truncate(mark);
                } else {
                    wrote = true;
                }
            }
        }
        Value::Object(_) => write_json(out, value),
    }
}

/// JavaScript's `JSON.stringify` of a parsed value.
fn write_json(out: &mut String, value: &Value<'_>) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Text(text) => json_string(out, text),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int(digits) => out.push_str(digits),
        Value::Double(double) if double.is_finite() => out.push_str(&js_number(*double)),
        Value::Double(_) => out.push_str("null"),
        Value::Array(values) => {
            out.push('[');
            for (index, entry) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(out, entry);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, entry)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                json_string(out, key);
                out.push(':');
                write_json(out, entry);
            }
            out.push('}');
        }
    }
}

/// JavaScript's `String(number)`.
fn js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

fn json_string(out: &mut String, text: &str) {
    /// Takes what serde_json writes straight into the string, so an escaped text is never held
    /// apart from it. serde_json writes a string as runs of its text cut at ASCII characters it
    /// escapes, and escapes, so every write is whole UTF-8.
    struct Into<'a>(&'a mut String);
    impl std::io::Write for Into<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let text = std::str::from_utf8(bytes)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            self.0.push_str(text);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // Writing a string into a string cannot fail.
    let _ = serde_json::to_writer(Into(out), text);
}

/// Attributes sorted by key, each key once.
type Attributes<'a> = Vec<(Text<'a>, Text<'a>)>;

/// Attributes as Motel's `attributeMap`: each key to its value as a string; a repeated key keeps
/// its last value. Held as a list sorted by key, allocated once at its size and sorted with
/// scratch of at most as many entries, both charged first.
fn attribute_map(attributes: Option<List<KeyValue<'_>>>) -> Result<Attributes<'_>, Invalid> {
    let attributes = attributes.unwrap_or_default();
    let wire = attributes.wire_bytes();
    let entry = size_of::<(Text, Text)>();
    charge_rows(heap(attributes.len() * entry))?;
    let mut map: Attributes = Vec::with_capacity(attributes.len());
    for attribute in attributes {
        short_name("An attribute's key", &attribute.key)?;
        let value = match attribute.value {
            Some(value) => stringify(parse(value)?)?,
            None => Cow::Borrowed(""),
        };
        map.push((attribute.key.0, value));
    }
    release(wire);
    // A stable sort keeps a repeated key's values in order; the last of them is kept. Its
    // scratch is freed when it returns.
    let scratch = heap(map.len() * entry);
    charge_rows(scratch)?;
    map.sort_by(|(left, _), (right, _)| left.cmp(right));
    release(scratch);
    let mut kept = 0;
    for index in 0..map.len() {
        if kept > 0 && map[kept - 1].0 == map[index].0 {
            map.swap(kept - 1, index);
        } else {
            map.swap(kept, index);
            kept += 1;
        }
    }
    map.truncate(kept);
    Ok(map)
}

/// The value of `key` in `map`.
fn lookup<'m, 'a>(map: &'m Attributes<'a>, key: &str) -> Option<&'m Text<'a>> {
    map.binary_search_by(|(found, _)| found.as_ref().cmp(key))
        .ok()
        .map(|index| &map[index].1)
}

/// Compact JSON with sorted keys, so equal attributes always have equal text: serde_json's
/// text of the map, written once at its length after it is charged.
fn canonical_json(map: Attributes<'_>) -> Result<String, Invalid> {
    let text = canonical_text(&map);
    release(heap(map.capacity() * size_of::<(Text, Text)>()));
    text
}

/// [`canonical_json`]'s text.
fn canonical_text(map: &Attributes<'_>) -> Result<String, Invalid> {
    let length = 2
        + map
            .iter()
            .map(|(key, value)| string_length(key) + 1 + string_length(value))
            .sum::<usize>()
        + map.len().saturating_sub(1);
    charge_rows(heap(length))?;
    let mut text = String::with_capacity(length);
    text.push('{');
    for (index, (key, value)) in map.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        json_string(&mut text, key);
        text.push(':');
        json_string(&mut text, value);
    }
    text.push('}');
    Ok(text)
}

/// A span's events as stored, `[{name, timeNs, attributes}]`: each event's attributes first,
/// then the whole text, written once at its length after it is charged.
fn events_json(events: Vec<Event<'_>>) -> Result<String, Invalid> {
    let wire = heap(events.capacity() * size_of::<Event>());
    let mut parts: Vec<(Text, i64, String)> = Vec::new();
    for event in events {
        if let Some(name) = &event.name {
            short_name("An event's name", name)?;
        }
        let time = nanos(event.time_unix_nano)?;
        let attributes = canonical_json(attribute_map(event.attributes)?)?;
        room_for_rows(&mut parts)?;
        parts.push((
            event.name.map_or(Cow::Borrowed("event"), |name| name.0),
            time,
            attributes,
        ));
    }
    let digits = |time: i64| time.checked_ilog10().map_or(1, |log| log as usize + 1);
    let length = 2
        + parts
            .iter()
            .map(|(name, time, attributes)| {
                r#"{"name":,"timeNs":,"attributes":}"#.len()
                    + string_length(name)
                    + digits(*time)
                    + attributes.len()
            })
            .sum::<usize>()
        + parts.len().saturating_sub(1);
    charge_rows(heap(length))?;
    let mut json = String::with_capacity(length);
    json.push('[');
    for (index, (name, time, attributes)) in parts.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str("{\"name\":");
        json_string(&mut json, name);
        json.push_str(",\"timeNs\":");
        json.push_str(&time.to_string());
        json.push_str(",\"attributes\":");
        json.push_str(attributes);
        json.push('}');
    }
    json.push(']');
    release(wire);
    release(heap(parts.capacity() * size_of::<(Text, i64, String)>()));
    release(
        parts
            .iter()
            .map(|(_, _, attributes)| heap(attributes.len()))
            .sum(),
    );
    Ok(json)
}

// --- Ids -------------------------------------------------------------------------------------

/// An OTLP id: hex of exactly `N` bytes in either case, or canonical base64 of `N` bytes.
pub fn binary_id<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() == N * 2 {
        let mut out = [0u8; N];
        let digits = text.as_bytes();
        let mut ok = true;
        for (index, byte) in out.iter_mut().enumerate() {
            match (
                hex_digit(digits[index * 2]),
                hex_digit(digits[index * 2 + 1]),
            ) {
                (Some(high), Some(low)) => *byte = high << 4 | low,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return Some(out);
        }
    }
    // Canonical base64 of `N` bytes has one length; anything else is not decoded at all.
    if text.len() != N.div_ceil(3) * 4 {
        return None;
    }
    let bytes = base64_decode(text)?;
    let out: [u8; N] = bytes.try_into().ok()?;
    (base64_encode(&out) == text).then_some(out)
}

fn hex_digit(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        b'A'..=b'F' => Some(digit - b'A' + 10),
        _ => None,
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(BASE64[(word >> (18 - 6 * index) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || !text.len().is_multiple_of(4) {
        return None;
    }
    let trimmed = text.trim_end_matches('=');
    if text.len() - trimmed.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut word = 0u32;
    let mut bits = 0;
    for byte in trimmed.bytes() {
        let digit = BASE64.iter().position(|candidate| *candidate == byte)? as u32;
        word = word << 6 | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((word >> bits) as u8);
            word &= (1 << bits) - 1;
        }
    }
    Some(out)
}
