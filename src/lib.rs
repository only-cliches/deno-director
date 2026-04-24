use lazy_static::lazy_static;
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::AtomicUsize;

mod bridge;
mod native_api;
mod worker;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::messages::DenoMsg;
use crate::worker::state::WorkerHandle;
use crate::worker::stream_plane::NativeIncomingPlane;

lazy_static! {
    pub static ref WORKERS: RwLock<HashMap<usize, WorkerHandle>> = RwLock::new(HashMap::new());
    pub(crate) static ref NEXT_ID: AtomicUsize = AtomicUsize::new(1);
}

/// Parses optional eval options, falling back to script-eval defaults on invalid input.
pub(crate) fn parse_eval_options<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> EvalOptions {
    EvalOptions::from_neon(cx, idx).unwrap_or_default()
}

/// Builds a generic JavaScript `Error` bridge value.
pub(crate) fn mk_err(message: impl Into<String>) -> JsValueBridge {
    crate::bridge::errors::error("Error", message)
}

/// Queues a runtime message and rejects attached promises when delivery is impossible.
///
/// Control-plane messages may block to preserve request completion semantics.
/// Data-plane messages are best-effort so high-volume streams cannot stall
/// Node producer threads when the bounded runtime channel is saturated.
pub(crate) fn queue_deno_msg_or_reject_with_backpressure(
    tx: tokio::sync::mpsc::Sender<DenoMsg>,
    msg: DenoMsg,
) {
    let is_data_plane = msg.is_data_plane();
    let send_result = match tx.try_send(msg) {
        Ok(()) => Ok(()),
        // Data-plane calls are best-effort and should not block producer threads.
        Err(tokio::sync::mpsc::error::TrySendError::Full(msg)) if is_data_plane => Err(msg),
        // Control-plane calls keep blocking semantics to preserve completion guarantees.
        Err(tokio::sync::mpsc::error::TrySendError::Full(msg)) => {
            tx.blocking_send(msg).map_err(|e| e.0)
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(msg)) => Err(msg),
    };
    if let Err(err) = send_result {
        match err {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => deferred.reject_with_error("Runtime is closed"),
            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::Gc { deferred }
            | DenoMsg::SetGlobal { deferred, .. }
            | DenoMsg::RegisterModule { deferred, .. }
            | DenoMsg::ClearModule { deferred, .. } => {
                deferred.reject_with_error("Runtime is closed")
            }
            DenoMsg::Eval { deferred: None, .. }
            | DenoMsg::PostMessage { .. }
            | DenoMsg::PostMessageTyped { .. }
            | DenoMsg::PostStreamChunk { .. }
            | DenoMsg::PostStreamChunkRaw { .. }
            | DenoMsg::PostStreamChunkRawBin { .. }
            | DenoMsg::PostStreamChunks { .. }
            | DenoMsg::PostStreamChunksRaw { .. }
            | DenoMsg::PostStreamControl { .. } => {}
        }
    }
}

/// Returns the control-plane sender for a live worker.
pub(crate) fn deno_control_tx_for_worker(
    worker_id: usize,
) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    WORKERS
        .read()
        .ok()
        .and_then(|map| map.get(&worker_id).map(|w| w.deno_tx.clone()))
}

/// Returns the data-plane sender for a live worker.
pub(crate) fn deno_data_tx_for_worker(
    worker_id: usize,
) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    WORKERS
        .read()
        .ok()
        .and_then(|map| map.get(&worker_id).map(|w| w.deno_data_tx.clone()))
}

/// Returns the native stream plane registered for a live worker, if enabled.
pub(crate) fn native_stream_plane_for_worker(
    worker_id: usize,
) -> Option<std::sync::Arc<NativeIncomingPlane>> {
    let map = WORKERS.read().ok()?;
    let handle = map.get(&worker_id)?;
    let guard = handle.native_stream_plane.lock().ok()?;
    guard.clone()
}

/// Routes a message to the correct runtime queue and rejects when the worker is closed.
pub(crate) fn queue_deno_msg_or_reject<F>(worker_id: usize, settler: PromiseSettler, mk_msg: F)
where
    F: FnOnce(PromiseSettler) -> DenoMsg,
{
    let msg = mk_msg(settler);
    let tx = if msg.is_data_plane() {
        deno_data_tx_for_worker(worker_id)
    } else {
        deno_control_tx_for_worker(worker_id)
    };
    if let Some(tx) = tx {
        queue_deno_msg_or_reject_with_backpressure(tx, msg);
    } else {
        match msg {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => deferred.reject_with_value_via_channel(mk_err("Runtime is closed")),
            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::Gc { deferred }
            | DenoMsg::SetGlobal { deferred, .. }
            | DenoMsg::RegisterModule { deferred, .. }
            | DenoMsg::ClearModule { deferred, .. } => {
                deferred.reject_with_value_via_channel(mk_err("Runtime is closed"))
            }
            DenoMsg::Eval { deferred: None, .. }
            | DenoMsg::PostMessage { .. }
            | DenoMsg::PostMessageTyped { .. }
            | DenoMsg::PostStreamChunk { .. }
            | DenoMsg::PostStreamChunkRaw { .. }
            | DenoMsg::PostStreamChunkRawBin { .. }
            | DenoMsg::PostStreamChunks { .. }
            | DenoMsg::PostStreamChunksRaw { .. }
            | DenoMsg::PostStreamControl { .. } => {}
        }
    }
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("DenoWorker", native_api::create_worker)?;
    Ok(())
}
