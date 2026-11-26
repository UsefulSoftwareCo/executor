//! A response body fed from a blocking query: a bounded queue of chunks, its end and its abort
//! kept under one lock, so the end can never overtake a chunk queued before it.
//!
//! `http_body_util::channel` (0.1.5) kept the end in a separate one-shot: a body whose sender
//! queued its last chunk and was dropped between the reader's two checks ended there, empty, and
//! a caller got a complete 200 with no answer. Here the reader takes a chunk or the end in one
//! look at the same state.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

use axum::body::Bytes;
use http_body::Frame;

/// The error a body aborted part way ends with; the caller sees the connection end early.
#[derive(Debug)]
pub struct CutOff;

impl std::fmt::Display for CutOff {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the query ended before its response was complete")
    }
}

impl std::error::Error for CutOff {}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End {
    /// Every chunk was sent: the body ends once they are read.
    Finished,
    /// Aborted: the body ends with `CutOff` once the chunks before it are read.
    CutOff,
}

struct State {
    chunks: VecDeque<Bytes>,
    capacity: usize,
    end: Option<End>,
    receiver_gone: bool,
    /// The reader waiting for a chunk or the end.
    reader: Option<Waker>,
}

struct Shared {
    state: Mutex<State>,
    /// Woken when a chunk is taken or the reader goes, for a sender waiting for room.
    room: tokio::sync::Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A body of at most `capacity` chunks queued at once: its sender and its reader.
pub fn body(capacity: usize) -> (BodySender, BodyReader) {
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            chunks: VecDeque::with_capacity(capacity),
            capacity: capacity.max(1),
            end: None,
            receiver_gone: false,
            reader: None,
        }),
        room: tokio::sync::Notify::new(),
    });
    (
        BodySender {
            shared: shared.clone(),
        },
        BodyReader { shared },
    )
}

/// Queues chunks; dropped, it ends the body after them; `abort` ends it with `CutOff`.
pub struct BodySender {
    shared: Arc<Shared>,
}

impl BodySender {
    /// Queue `chunk`, waiting for room. `Err` gives it back when the reader has gone. A wait cut
    /// short (the future dropped) queues nothing.
    pub async fn send(&mut self, chunk: Bytes) -> Result<(), Bytes> {
        loop {
            let notified = self.shared.room.notified();
            tokio::pin!(notified);
            // Registered before the state is looked at, so room made after the look wakes it.
            notified.as_mut().enable();
            {
                let mut state = self.shared.lock();
                if state.receiver_gone {
                    return Err(chunk);
                }
                if state.chunks.len() < state.capacity {
                    state.chunks.push_back(chunk);
                    let reader = state.reader.take();
                    drop(state);
                    if let Some(reader) = reader {
                        reader.wake();
                    }
                    return Ok(());
                }
            }
            // Full: wait until the reader takes a chunk or goes.
            notified.await;
        }
    }

    /// End the body with `CutOff`, after the chunks already queued.
    pub fn abort(self) {
        self.end(End::CutOff);
    }

    fn end(&self, end: End) {
        let waker = {
            let mut state = self.shared.lock();
            if state.end.is_some() {
                return;
            }
            state.end = Some(end);
            state.reader.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl Drop for BodySender {
    fn drop(&mut self) {
        self.end(End::Finished);
    }
}

/// The body as the HTTP server reads it.
pub struct BodyReader {
    shared: Arc<Shared>,
}

impl BodyReader {
    /// The next chunk, or the end, if either is there: looked at together, under one lock, so the
    /// end is only ever seen after every chunk queued before it.
    fn take(&self) -> Option<Option<Result<Frame<Bytes>, CutOff>>> {
        let mut state = self.shared.lock();
        if let Some(chunk) = state.chunks.pop_front() {
            drop(state);
            self.shared.room.notify_one();
            return Some(Some(Ok(Frame::data(chunk))));
        }
        match state.end {
            Some(End::Finished) => Some(None),
            Some(End::CutOff) => Some(Some(Err(CutOff))),
            None => None,
        }
    }
}

impl http_body::Body for BodyReader {
    type Data = Bytes;
    type Error = CutOff;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, CutOff>>> {
        if let Some(frame) = self.take() {
            return Poll::Ready(frame);
        }
        // Nothing yet: register, then look once more, so a chunk or an end that arrived while the
        // waker was cloned (outside the lock) is not missed.
        let waker = context.waker().clone();
        {
            let mut state = self.shared.lock();
            if state.chunks.is_empty() && state.end.is_none() {
                state.reader = Some(waker);
                return Poll::Pending;
            }
        }
        match self.take() {
            Some(frame) => Poll::Ready(frame),
            None => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        let state = self.shared.lock();
        state.chunks.is_empty() && state.end == Some(End::Finished)
    }
}

impl Drop for BodyReader {
    fn drop(&mut self) {
        self.shared.lock().receiver_gone = true;
        self.shared.room.notify_one();
    }
}
