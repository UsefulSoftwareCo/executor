//! Matching an operation name or a log body as Motel did through its FTS5 tables, in Rust over
//! each row a query reads.
//!
//! Motel took the query's words, runs of two or more of `[A-Za-z0-9_]` (`tokenizeFts`), and
//! matched `word1* AND word2* ...` against an FTS5 table with the `unicode61` tokenizer. FTS5
//! tokenizes each query word as it does text, so a word joined by `_` is a phrase of its tokens,
//! the last one a prefix, and a word with no token (`__`) matches nothing. A query with no word
//! fell back to `LIKE '%query%'`. `tests/store.rs` compares both with SQLite itself.
//!
//! Both are linear in the text: the words are matched with one pass over the text's tokens per
//! word, each word a Knuth-Morris-Pratt automaton over tokens, and `LIKE` with one pass per run
//! between its `%`s, a shift-and automaton over characters. A query's work is at most the text's
//! length times its number of words, or times its pattern's length over 64; every
//! `CHECK_EVERY` units of it, the query's deadline, the read gate and the caller are checked,
//! inside long tokens too.

use std::collections::HashMap;

use crate::readers::{Out, Stop};
use crate::unicode61::{DROP, FOLD, TOKEN};

/// Units of work (a byte of text read, a token compared with a word) between checks.
const CHECK_EVERY: u64 = 1 << 16;

pub enum TextMatch {
    /// Every word must match: its tokens in a row in the text, the last as a prefix.
    Words(Vec<Word>),
    /// A word with no token: FTS5 matches nothing.
    Nothing,
    /// SQLite's `LIKE '%query%'`: ASCII case folded, `%` any run, `_` any one character.
    Like(Like),
}

/// One query word: its tokens, ASCII lowercase, and the Knuth-Morris-Pratt failure function of
/// all but the last.
pub struct Word {
    tokens: Vec<Vec<u8>>,
    fail: Vec<usize>,
}

impl TextMatch {
    pub fn new(query: &str) -> TextMatch {
        let words: Vec<&str> = query
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .filter(|word| word.len() > 1)
            .collect();
        if words.is_empty() {
            return TextMatch::Like(Like::new(query));
        }
        let mut parsed: Vec<Vec<Vec<u8>>> = Vec::new();
        for word in words {
            let tokens: Vec<Vec<u8>> = word
                .split('_')
                .filter(|token| !token.is_empty())
                .map(|token| token.to_ascii_lowercase().into_bytes())
                .collect();
            if tokens.is_empty() {
                return TextMatch::Nothing;
            }
            // A word given twice matches where it matches once.
            if !parsed.contains(&tokens) {
                parsed.push(tokens);
            }
        }
        TextMatch::Words(parsed.into_iter().map(Word::new).collect())
    }

    /// Whether `text` matches. Checks `out` (deadline, gate, caller) as it goes.
    pub fn matches(&self, text: &str, out: &Out) -> Result<bool, Stop> {
        match self {
            TextMatch::Nothing => Ok(false),
            TextMatch::Like(like) => like.matches(text, &mut Budget::new(out)),
            TextMatch::Words(words) => match_words(words, text, &mut Budget::new(out)),
        }
    }
}

/// Counts work and checks `out` every `CHECK_EVERY` units.
struct Budget<'a> {
    out: &'a Out,
    work: u64,
}

impl<'a> Budget<'a> {
    fn new(out: &'a Out) -> Budget<'a> {
        Budget { out, work: 0 }
    }

    fn spend(&mut self, units: u64) -> Result<(), Stop> {
        self.work += units;
        if self.work >= CHECK_EVERY {
            self.work = 0;
            self.out.check()?;
        }
        Ok(())
    }
}

impl Word {
    fn new(tokens: Vec<Vec<u8>>) -> Word {
        // fail[i]: the longest proper prefix of tokens[..=i] that is also its suffix.
        let mut fail = vec![0; tokens.len()];
        let mut length = 0;
        for index in 1..tokens.len() {
            while length > 0 && tokens.get(index) != tokens.get(length) {
                length = fail.get(length - 1).copied().unwrap_or(0);
            }
            if tokens.get(index) == tokens.get(length) {
                length += 1;
            }
            if let Some(slot) = fail.get_mut(index) {
                *slot = length;
            }
        }
        Word { tokens, fail }
    }

    /// The longest token, which is all of a text token that comparisons need.
    fn longest(&self) -> usize {
        self.tokens.iter().map(Vec::len).max().unwrap_or(0)
    }

    /// Advance from `matched` tokens matched by the text token `token` (its first bytes, and
    /// its whole length). Returns the new count, or `None` when the word is found.
    fn step(&self, mut matched: usize, token: &[u8], length: usize) -> Option<usize> {
        let last = self.tokens.len() - 1;
        loop {
            let Some(expected) = self.tokens.get(matched) else {
                return Some(0);
            };
            if matched == last {
                if length >= expected.len() && token.starts_with(expected) {
                    return None;
                }
            } else if length == expected.len() && token == expected.as_slice() {
                return Some(matched + 1);
            }
            if matched == 0 {
                return Some(0);
            }
            matched = self.fail.get(matched - 1).copied().unwrap_or(0);
        }
    }
}

/// Whether every word is found in `text`'s tokens.
fn match_words(words: &[Word], text: &str, budget: &mut Budget) -> Result<bool, Stop> {
    // Comparisons need a token's first bytes up to the longest query token, and its length.
    let keep = words.iter().map(Word::longest).max().unwrap_or(0) + 1;
    let mut token: Vec<u8> = Vec::with_capacity(keep);
    let mut length = 0usize;
    let mut in_token = false;
    // Per word: tokens matched so far, or None once found.
    let mut state: Vec<Option<usize>> = vec![Some(0); words.len()];
    let mut remaining = words.len();
    let mut feed = |token: &[u8], length: usize, budget: &mut Budget| -> Result<bool, Stop> {
        // A token of only dropped characters is no token, as in FTS5.
        if length == 0 {
            return Ok(false);
        }
        budget.spend(remaining as u64)?;
        for (word, slot) in words.iter().zip(state.iter_mut()) {
            if let Some(matched) = *slot {
                *slot = word.step(matched, token, length);
                if slot.is_none() {
                    remaining -= 1;
                }
            }
        }
        Ok(remaining == 0)
    };
    let mut bytes = [0u8; 4];
    for character in text.chars() {
        budget.spend(1)?;
        match fold(character) {
            Fold::Separator => {
                if in_token {
                    if feed(&token, length, budget)? {
                        return Ok(true);
                    }
                    token.clear();
                    length = 0;
                    in_token = false;
                }
            }
            Fold::Dropped => in_token = true,
            Fold::To(folded) => {
                in_token = true;
                let encoded = folded.encode_utf8(&mut bytes).as_bytes();
                for byte in encoded {
                    if token.len() < keep {
                        token.push(*byte);
                    }
                }
                length += encoded.len();
            }
        }
    }
    Ok(in_token && feed(&token, length, budget)?)
}

enum Fold {
    Separator,
    Dropped,
    To(char),
}

/// What `unicode61` makes of one character.
fn fold(character: char) -> Fold {
    let code = u32::from(character);
    if code < 0x80 {
        return match character {
            'A'..='Z' => Fold::To(character.to_ascii_lowercase()),
            'a'..='z' | '0'..='9' => Fold::To(character),
            _ => Fold::Separator,
        };
    }
    let token = TOKEN
        .binary_search_by(|(start, end)| {
            if *end < code {
                std::cmp::Ordering::Less
            } else if *start > code {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok();
    if !token {
        return Fold::Separator;
    }
    let run = FOLD.binary_search_by(|(start, count, _)| {
        if start + count <= code {
            std::cmp::Ordering::Less
        } else if *start > code {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    match run.ok().and_then(|index| FOLD.get(index)) {
        None => Fold::To(character),
        Some((_, _, DROP)) => Fold::Dropped,
        Some((_, _, delta)) => code
            .checked_add_signed(*delta)
            .and_then(char::from_u32)
            .map_or(Fold::To(character), Fold::To),
    }
}

/// What `unicode61` makes of a whole text: its tokens, folded. For `tests/store.rs`.
pub fn tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut in_token = false;
    for character in text.chars().chain(std::iter::once(' ')) {
        match fold(character) {
            Fold::Separator => {
                if in_token && !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
                token.clear();
                in_token = false;
            }
            Fold::Dropped => in_token = true,
            Fold::To(folded) => {
                in_token = true;
                token.push(folded);
            }
        }
    }
    tokens
}

/// A `LIKE '%query%'` pattern: the runs between its `%`s, each to be found in order, leftmost
/// first, which is how a pattern of only `%` and `_` wildcards matches.
pub struct Like {
    runs: Vec<Run>,
    /// The pattern ends without `%`: the last run must end the text. SQLite reads a pattern up to
    /// its first NUL, so `%query%` with a NUL in the query loses its closing `%`.
    anchored: bool,
}

/// One run between `%`s, as a shift-and automaton: for each character of the run, a bit per
/// position it may stand at; `_` stands anywhere.
struct Run {
    length: usize,
    words: usize,
    /// Per distinct character of the run, ASCII lowercase: its position bits.
    masks: HashMap<char, Vec<u64>>,
    /// The positions of `_`.
    any: Vec<u64>,
    /// The run's characters, ASCII lowercase, for matching it at the end of a text.
    characters: Vec<char>,
}

impl Like {
    fn new(query: &str) -> Like {
        // Motel's pattern was `%query%`; SQLite reads it up to its first NUL.
        let (query, anchored) = match query.split_once('\0') {
            Some((before, _)) => (before, !before.ends_with('%')),
            None => (query, false),
        };
        let runs = query
            .split('%')
            .filter(|run| !run.is_empty())
            .map(Run::new)
            .collect();
        Like { runs, anchored }
    }

    fn matches(&self, text: &str, budget: &mut Budget) -> Result<bool, Stop> {
        // SQLite reads a text up to its first NUL too.
        let text = text.split('\0').next().unwrap_or("");
        let (runs, last) = match (self.anchored, self.runs.split_last()) {
            (true, Some((last, runs))) => (runs, Some(last)),
            _ => (self.runs.as_slice(), None),
        };
        let mut rest = text;
        for run in runs {
            match run.find(rest, budget)? {
                Some(end) => rest = rest.get(end..).unwrap_or(""),
                None => return Ok(false),
            }
        }
        Ok(last.is_none_or(|last| last.ends(rest)))
    }
}

impl Run {
    fn new(run: &str) -> Run {
        let characters: Vec<char> = run.chars().map(|c| c.to_ascii_lowercase()).collect();
        let length = characters.len();
        let words = length.div_ceil(64);
        let mut masks: HashMap<char, Vec<u64>> = HashMap::new();
        let mut any = vec![0u64; words];
        for (position, character) in characters.iter().enumerate() {
            let (word, bit) = (position / 64, 1u64 << (position % 64));
            let target = if *character == '_' {
                &mut any
            } else {
                masks.entry(*character).or_insert_with(|| vec![0u64; words])
            };
            if let Some(slot) = target.get_mut(word) {
                *slot |= bit;
            }
        }
        Run {
            length,
            words,
            masks,
            any,
            characters,
        }
    }

    /// Whether `text` ends with the run.
    fn ends(&self, text: &str) -> bool {
        let mut tail = text.chars().rev();
        for expected in self.characters.iter().rev() {
            match tail.next() {
                Some(found) if *expected == '_' || found.to_ascii_lowercase() == *expected => {}
                _ => return false,
            }
        }
        true
    }

    /// The byte offset just past the leftmost match of the run in `text`.
    fn find(&self, text: &str, budget: &mut Budget) -> Result<Option<usize>, Stop> {
        let mut state = vec![0u64; self.words];
        let (last_word, last_bit) = ((self.length - 1) / 64, 1u64 << ((self.length - 1) % 64));
        for (offset, character) in text.char_indices() {
            budget.spend(self.words as u64)?;
            let character = character.to_ascii_lowercase();
            let mask = self.masks.get(&character).map(Vec::as_slice);
            // state = ((state << 1) | 1) & (mask | any), across words.
            let mut carry = 1u64;
            for (index, word) in state.iter_mut().enumerate() {
                let next_carry = *word >> 63;
                let allowed = mask.and_then(|mask| mask.get(index)).copied().unwrap_or(0)
                    | self.any.get(index).copied().unwrap_or(0);
                *word = ((*word << 1) | carry) & allowed;
                carry = next_carry;
            }
            if state
                .get(last_word)
                .is_some_and(|word| word & last_bit != 0)
            {
                return Ok(Some(offset + character.len_utf8()));
            }
        }
        Ok(None)
    }
}
