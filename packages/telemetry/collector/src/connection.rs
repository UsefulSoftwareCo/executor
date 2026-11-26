//! The response an HTTP connection is sending: its deadline, and the reader permit it holds.
//!
//! A query's response must be sent within its deadline (`readers::QUERY_DEADLINE`). While the
//! query runs it checks that itself; once it has queued its last bytes, they wait in the
//! response body and in the HTTP server's own write buffer (about 400 KB) for the caller to read
//! them. So every connection carries a `ResponseDeadline`: a query's answer sets it, each new
//! request on the connection clears it, and a write to the connection past it fails, which ends
//! the connection and drops whatever was still queued. Reads are never affected, so an idle
//! connection whose last response was sent stays open.
//!
//! The answer's reader permit is held here too, until the body has ended and the server's write
//! buffer has been flushed to the socket, or the connection ends: so the bytes the server holds
//! for a slow caller count against the readers as the query's own did.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;

use axum::extract::Request;
use axum::extract::connect_info::Connected;
use axum::middleware::Next;
use axum::response::Response;
use axum::serve::{IncomingStream, Listener};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::OwnedSemaphorePermit;

/// The response being sent on a connection; nothing between requests.
#[derive(Clone, Default)]
pub struct ResponseDeadline(Arc<Mutex<Sending>>);

#[derive(Default)]
struct Sending {
    /// When it must be sent by.
    deadline: Option<Instant>,
    /// Its reader permit, until it has left the collector.
    permit: Option<Arc<OwnedSemaphorePermit>>,
    /// The body has given its last bytes to the server.
    body_ended: bool,
    /// Bytes were written to the socket since the last completed flush.
    unflushed: bool,
    /// Counts a response ended at its deadline here, after its body had ended whole
    /// (`readers::Readers` counts one ended before; `readers::Streamed` one dropped unfinished).
    cut_off: Option<Arc<AtomicU64>>,
}

/// The server logs a connection's address when accepting it fails; this one has none to show.
impl std::fmt::Debug for ResponseDeadline {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ResponseDeadline")
    }
}

impl ResponseDeadline {
    /// A query's response starts: it must be sent by `at`, and holds `permit` until it has left.
    pub fn start(&self, at: Instant, permit: Arc<OwnedSemaphorePermit>, cut_off: Arc<AtomicU64>) {
        let mut sending = self.lock();
        sending.deadline = Some(at);
        sending.permit = Some(permit);
        sending.body_ended = false;
        sending.cut_off = Some(cut_off);
    }

    /// The deadline passed with bytes still to send: the connection ends.
    fn missed(&self) {
        let mut sending = self.lock();
        if sending.body_ended
            && sending.permit.take().is_some()
            && let Some(cut_off) = &sending.cut_off
        {
            cut_off.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The body has given the server its last bytes, or was dropped. The permit goes once those
    /// bytes are flushed to the socket. `counted`: the body was dropped unfinished past its
    /// deadline and counted itself as cut off, so the deadline passing here is not counted again.
    pub fn body_ended(&self, counted: bool) {
        let mut sending = self.lock();
        sending.body_ended = true;
        if counted {
            sending.cut_off = None;
        }
        if !sending.unflushed {
            sending.permit = None;
        }
    }

    /// A new request: the last response has been sent.
    fn clear(&self) {
        *self.lock() = Sending::default();
    }

    fn deadline(&self) -> Option<Instant> {
        self.lock().deadline
    }

    fn wrote(&self) {
        self.lock().unflushed = true;
    }

    fn flushed(&self) {
        let mut sending = self.lock();
        sending.unflushed = false;
        if sending.body_ended {
            sending.permit = None;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Sending> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A listener whose connections carry a `ResponseDeadline`, given to each request as its
/// `ConnectInfo`.
pub struct Guarding<L>(pub L);

impl<L: Listener> Listener for Guarding<L> {
    type Io = Guarded<L::Io>;
    type Addr = ResponseDeadline;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, _) = self.0.accept().await;
        let deadline = ResponseDeadline::default();
        (
            Guarded {
                inner: io,
                deadline: deadline.clone(),
                timer: None,
            },
            deadline,
        )
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(ResponseDeadline::default())
    }
}

impl<L: Listener> Connected<IncomingStream<'_, Guarding<L>>> for ResponseDeadline {
    fn connect_info(stream: IncomingStream<'_, Guarding<L>>) -> Self {
        stream.remote_addr().clone()
    }
}

/// Clears the connection's deadline as each request begins: the last response has been sent.
pub async fn new_request(request: Request, next: Next) -> Response {
    if let Some(deadline) = request
        .extensions()
        .get::<axum::extract::ConnectInfo<ResponseDeadline>>()
    {
        deadline.0.clear();
    }
    next.run(request).await
}

/// A connection whose writes fail past its `ResponseDeadline`.
pub struct Guarded<S> {
    inner: S,
    deadline: ResponseDeadline,
    /// Wakes a write waiting on a slow caller when the deadline passes.
    timer: Option<(Instant, Pin<Box<tokio::time::Sleep>>)>,
}

impl<S> Guarded<S> {
    /// Fails once the deadline has passed; before then, arranges to be woken when it does.
    fn check(&mut self, context: &mut Context<'_>) -> io::Result<()> {
        let Some(at) = self.deadline.deadline() else {
            self.timer = None;
            return Ok(());
        };
        if Instant::now() >= at {
            self.deadline.missed();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the response was not sent by its deadline",
            ));
        }
        if self
            .timer
            .as_ref()
            .is_none_or(|(timer_at, _)| *timer_at != at)
        {
            self.timer = Some((
                at,
                Box::pin(tokio::time::sleep_until(tokio::time::Instant::from_std(at))),
            ));
        }
        if let Some((_, timer)) = self.timer.as_mut()
            && timer.as_mut().poll(context).is_ready()
        {
            self.deadline.missed();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the response was not sent by its deadline",
            ));
        }
        Ok(())
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Guarded<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Guarded<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Err(error) = self.check(context) {
            return Poll::Ready(Err(error));
        }
        let written = Pin::new(&mut self.inner).poll_write(context, bytes);
        if let Poll::Ready(Ok(count)) = written
            && count > 0
        {
            self.deadline.wrote();
        }
        written
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        if let Err(error) = self.check(context) {
            return Poll::Ready(Err(error));
        }
        let written = Pin::new(&mut self.inner).poll_write_vectored(context, buffers);
        if let Poll::Ready(Ok(count)) = written
            && count > 0
        {
            self.deadline.wrote();
        }
        written
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.check(context) {
            return Poll::Ready(Err(error));
        }
        // The server flushes the socket only once it has written all it buffered.
        let flushed = Pin::new(&mut self.inner).poll_flush(context);
        if let Poll::Ready(Ok(())) = flushed {
            self.deadline.flushed();
        }
        flushed
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

/// A connection that ends drops its response, permit included.
impl<S> Drop for Guarded<S> {
    fn drop(&mut self) {
        self.deadline.clear();
    }
}
