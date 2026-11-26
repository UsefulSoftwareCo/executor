//! Stopping: a stop state that stays set, and the drain that gives open requests a grace period.

use std::future::Future;
use std::time::Duration;

use tokio::sync::watch;

use crate::log;

/// Whether the collector is stopping. It is set once and never cleared, so a waiter that starts
/// after it was set still sees it. An edge-triggered notification would be lost if it fired
/// before the waiter existed, and the drain's grace period would then never start.
#[derive(Clone)]
pub struct Stop {
    state: std::sync::Arc<watch::Sender<bool>>,
}

impl Default for Stop {
    fn default() -> Self {
        Stop {
            state: std::sync::Arc::new(watch::Sender::new(false)),
        }
    }
}

impl Stop {
    pub fn set(&self) {
        self.state.send_replace(true);
    }

    /// Resolves once the stop state is set, at once if it already is.
    pub async fn wait(&self) {
        let mut receiver = self.state.subscribe();
        // The sender lives as long as `self`, so waiting cannot fail.
        let _ = receiver.wait_for(|stopping| *stopping).await;
    }
}

/// Run `server` until it ends, or until `grace` has passed since `stop` was set, whichever is
/// first. Requests still open at the end of the grace period are abandoned.
pub async fn drain(
    server: impl Future<Output = std::io::Result<()>>,
    stop: &Stop,
    grace: Duration,
) -> Result<(), String> {
    let deadline = async {
        stop.wait().await;
        tokio::time::sleep(grace).await;
    };
    tokio::select! {
        result = server => result.map_err(|error| error.to_string()),
        () = deadline => {
            log::warn("requests still open when the collector stopped", &[]);
            Ok(())
        }
    }
}
