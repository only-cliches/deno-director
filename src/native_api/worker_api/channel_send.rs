use crate::worker::messages::DenoMsg;

pub(super) enum SendOutcome {
    Sent,
    Full,
    Closed,
}

/// Attempts a nonblocking send on the data-plane channel.
///
/// The TypeScript wrapper treats `Full` as backpressure and may retry, batch, or
/// fail the specific high-volume operation without blocking the Node thread.
pub(super) fn send_with_backpressure(
    tx: &tokio::sync::mpsc::Sender<DenoMsg>,
    msg: DenoMsg,
) -> SendOutcome {
    match tx.try_send(msg) {
        Ok(()) => SendOutcome::Sent,
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => SendOutcome::Full,
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => SendOutcome::Closed,
    }
}
