//! One JSON object per line on stderr: `{"level","message",...fields}`. Both hosts forward the
//! collector's stderr into their own logs.

use std::io::Write;

use serde_json::{Map, Value};

fn write(level: &str, message: &str, fields: &[(&str, Value)]) {
    let mut line = Map::new();
    line.insert("level".to_owned(), level.into());
    line.insert("message".to_owned(), message.into());
    for (key, value) in fields {
        line.insert((*key).to_owned(), value.clone());
    }
    let mut text = Value::Object(line).to_string();
    text.push('\n');
    // A closed stderr leaves nowhere to report to.
    let _ = std::io::stderr().lock().write_all(text.as_bytes());
}

pub fn info(message: &str, fields: &[(&str, Value)]) {
    write("info", message, fields);
}

pub fn warn(message: &str, fields: &[(&str, Value)]) {
    write("warn", message, fields);
}

pub fn error(message: &str, fields: &[(&str, Value)]) {
    write("error", message, fields);
}
