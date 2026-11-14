//! The response body a query streams through (`body`): its end never overtakes a chunk.
//!
//! The round-five failure: with `http_body_util::channel` a body whose sender queued its last
//! chunk and was dropped between the reader's two checks ended empty, and a caller got a
//! complete 200 with no answer. These tests place that interleaving exactly, and race it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Wake, Waker};

use axum::body::Bytes;
use executor_collector::body::{BodyReader, BodySender, body};
use http_body::Body;

struct Count(AtomicUsize);

impl Wake for Count {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn poll(reader: &mut BodyReader, waker: &Waker) -> Poll<Option<Result<Bytes, String>>> {
    let mut context = Context::from_waker(waker);
    Pin::new(reader).poll_frame(&mut context).map(|frame| {
        frame.map(|frame| {
            frame
                .map(|frame| frame.into_data().expect("data"))
                .map_err(|error| error.to_string())
        })
    })
}

fn send(sender: &mut BodySender, chunk: &'static [u8]) {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(sender.send(Bytes::from_static(chunk)))
        .expect("sent");
}

/// The interleaving that lost the answer: the reader looks while nothing is queued; the sender
/// then queues its last chunk and is dropped; the reader is woken and looks again. It gets the
/// chunk, then the end, never the end first.
#[test]
fn the_end_never_overtakes_a_queued_chunk() {
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let waker = Waker::from(count.clone());
    let (mut sender, mut reader) = body(4);
    assert!(
        poll(&mut reader, &waker).is_pending(),
        "nothing is queued yet"
    );
    send(&mut sender, b"{\"data\":[]}");
    drop(sender);
    assert!(
        count.0.load(Ordering::SeqCst) > 0,
        "the reader was not woken"
    );
    match poll(&mut reader, &waker) {
        Poll::Ready(Some(Ok(chunk))) => assert_eq!(&chunk[..], b"{\"data\":[]}"),
        other => panic!("the queued chunk was lost: {other:?}"),
    }
    assert!(matches!(poll(&mut reader, &waker), Poll::Ready(None)));
}

/// A body aborted after two chunks gives both, then the cut-off error; a sender dropped with
/// nothing queued ends the body at once.
#[test]
fn an_aborted_body_gives_its_chunks_then_ends_cut_off() {
    let waker = Waker::from(Arc::new(Count(AtomicUsize::new(0))));
    let (mut sender, mut reader) = body(4);
    send(&mut sender, b"one");
    send(&mut sender, b"two");
    sender.abort();
    assert!(
        matches!(poll(&mut reader, &waker), Poll::Ready(Some(Ok(chunk))) if &chunk[..] == b"one")
    );
    assert!(
        matches!(poll(&mut reader, &waker), Poll::Ready(Some(Ok(chunk))) if &chunk[..] == b"two")
    );
    assert!(matches!(
        poll(&mut reader, &waker),
        Poll::Ready(Some(Err(_)))
    ));
    let (sender, mut reader) = body(4);
    drop(sender);
    assert!(matches!(poll(&mut reader, &waker), Poll::Ready(None)));
}

/// A full body makes the sender wait until the reader takes a chunk, and a gone reader gives
/// the sender its chunk back. The waiting send is polled by hand: pending while the body is full,
/// woken when the reader takes a chunk, then done.
#[test]
fn a_full_body_waits_for_the_reader_and_a_gone_one_refuses() {
    let (mut sender, mut reader) = body(1);
    send(&mut sender, b"first");
    let woken = Arc::new(Count(AtomicUsize::new(0)));
    let sender_waker = Waker::from(woken.clone());
    let mut context = Context::from_waker(&sender_waker);
    {
        let mut waiting = Box::pin(sender.send(Bytes::from_static(b"second")));
        assert!(
            waiting.as_mut().poll(&mut context).is_pending(),
            "a full body did not make the sender wait"
        );
        assert_eq!(woken.0.load(Ordering::SeqCst), 0, "woken with no room made");
        let reader_waker = Waker::from(Arc::new(Count(AtomicUsize::new(0))));
        assert!(
            matches!(poll(&mut reader, &reader_waker), Poll::Ready(Some(Ok(chunk))) if &chunk[..] == b"first")
        );
        assert!(
            woken.0.load(Ordering::SeqCst) > 0,
            "room made by the reader did not wake the sender"
        );
        assert!(
            matches!(waiting.as_mut().poll(&mut context), Poll::Ready(Ok(()))),
            "the woken sender did not go on"
        );
    }
    drop(reader);
    let mut refused = Box::pin(sender.send(Bytes::from_static(b"third")));
    assert!(
        matches!(refused.as_mut().poll(&mut context), Poll::Ready(Err(_))),
        "a gone reader took a chunk"
    );
}

/// The race itself, as it happened: a short body sent and ended on one thread while another
/// reads it, many times. Every body read in full holds its chunk.
#[test]
fn short_bodies_raced_against_their_reader_are_never_empty() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        for _ in 0..20_000 {
            let (mut sender, reader) = body(4);
            let writer = tokio::task::spawn_blocking(move || {
                tokio::runtime::Handle::current()
                    .block_on(sender.send(Bytes::from_static(b"{\"data\":[]}")))
                    .expect("sent");
            });
            let read = http_body_util::BodyExt::collect(reader)
                .await
                .expect("a whole body")
                .to_bytes();
            writer.await.expect("writer");
            assert_eq!(
                &read[..],
                b"{\"data\":[]}",
                "a body ended without its chunk"
            );
        }
    });
}

/// The race's own window, placed as the reviewer placed it against `http_body_util::channel`: the
/// sender queues its last chunk and is dropped while the reader is between finding nothing and
/// registering to be woken (here, inside the waker's clone). The reader's next look still gives
/// the chunk before the end. (`http_body_util` 0.1.5 answered the end first, and lost it.)
#[test]
fn a_chunk_sent_while_the_reader_registers_is_not_lost() {
    use std::sync::Mutex;
    use std::task::{RawWaker, RawWakerVTable};

    struct State {
        clones: AtomicUsize,
        sender: Mutex<Option<BodySender>>,
    }
    static STATE: std::sync::OnceLock<Arc<State>> = std::sync::OnceLock::new();
    fn clone(_: *const ()) -> RawWaker {
        let state = STATE.get().expect("state");
        if state.clones.fetch_add(1, Ordering::SeqCst) == 0 {
            let mut sender = state.sender.lock().expect("lock").take().expect("sender");
            send(&mut sender, b"{\"data\":[]}");
            drop(sender);
        }
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    fn noop(_: *const ()) {}
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);

    let (sender, mut reader) = body(4);
    STATE
        .set(Arc::new(State {
            clones: AtomicUsize::new(0),
            sender: Mutex::new(Some(sender)),
        }))
        .ok()
        .expect("set once");
    // SAFETY: the vtable's functions ignore the data pointer and never free anything.
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let first = poll(&mut reader, &waker);
    assert!(
        STATE.get().expect("state").clones.load(Ordering::SeqCst) > 0,
        "the reader never registered"
    );
    let chunk = match first {
        Poll::Ready(Some(Ok(chunk))) => chunk,
        Poll::Pending => match poll(&mut reader, &waker) {
            Poll::Ready(Some(Ok(chunk))) => chunk,
            other => panic!("the chunk was lost: {other:?}"),
        },
        other => panic!("the end came before the chunk: {other:?}"),
    };
    assert_eq!(&chunk[..], b"{\"data\":[]}");
    assert!(matches!(poll(&mut reader, &waker), Poll::Ready(None)));
}
