//! The drain: open requests get their grace period however the stop and the drain are ordered.

use std::time::{Duration, Instant};

use executor_collector::lifecycle::{Stop, drain};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime")
}

/// A server that never finishes, as one does while a request stays open.
fn open_forever() -> impl std::future::Future<Output = std::io::Result<()>> {
    std::future::pending()
}

/// The stop arrives before the drain is first polled: the window in which an edge-triggered
/// notification was lost and the grace period never started.
#[test]
fn a_stop_set_before_the_drain_starts_still_ends_it_after_the_grace_period() {
    runtime().block_on(async {
        let stop = Stop::default();
        stop.set();
        let started = Instant::now();
        let drained = tokio::time::timeout(
            Duration::from_secs(5),
            drain(open_forever(), &stop, Duration::from_millis(100)),
        )
        .await;
        assert!(drained.is_ok(), "the drain never ended after an early stop");
        assert!(started.elapsed() >= Duration::from_millis(100));
    });
}

#[test]
fn a_stop_set_while_draining_ends_it_after_the_grace_period() {
    runtime().block_on(async {
        let stop = Stop::default();
        let setter = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            setter.set();
        });
        let drained = tokio::time::timeout(
            Duration::from_secs(5),
            drain(open_forever(), &stop, Duration::from_millis(100)),
        )
        .await;
        assert!(drained.is_ok(), "the drain never ended");
    });
}

#[test]
fn a_server_that_finishes_ends_the_drain_without_a_stop() {
    runtime().block_on(async {
        let stop = Stop::default();
        let drained = tokio::time::timeout(
            Duration::from_secs(5),
            drain(async { Ok(()) }, &stop, Duration::from_secs(60)),
        )
        .await;
        assert_eq!(drained.expect("ended"), Ok(()));
    });
}
