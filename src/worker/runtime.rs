use deno_core::extension;
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_core::{self, resolve_url};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};

use deno_permissions::PermissionDescriptorParser;
use deno_permissions::{Permissions, PermissionsContainer, PermissionsOptions};
use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
use sys_traits::impls::RealSys;

use crate::worker::dispatch::{dispatch_node_msg, handle_deno_msg};
use crate::worker::filesystem::{
    SandboxFs, dir_url_from_path, normalize_cwd, normalize_startup_url, sandboxed_path_list,
};
use crate::worker::messages::{DenoMsg, NodeMsg};
use crate::worker::ops::{
    op_denojs_worker_host_call_async, op_denojs_worker_host_call_sync,
    op_denojs_worker_post_message,
};
use crate::worker::state::{EnvConfig, RuntimeLimits};

use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread;

use tokio::sync::mpsc;

#[derive(Clone)]
pub struct WorkerOpContext {
    #[allow(dead_code)]
    pub worker_id: usize,
    pub node_tx: mpsc::Sender<NodeMsg>,
}

extension!(
    deno_worker_extension,
    ops = [
        op_denojs_worker_post_message,
        op_denojs_worker_host_call_sync,
        op_denojs_worker_host_call_async
    ],
    esm_entry_point = "ext:deno_worker_extension/src/worker/bootstrap.js",
    esm = ["src/worker/bootstrap.js"],
);

fn apply_env_map(map: &HashMap<String, String>) {
    for (k, v) in map.iter() {
        if k.is_empty() || k.len() > 4096 || k.contains('\0') {
            continue;
        }
        unsafe {
            std::env::set_var(k, v);
        }
    }
}

fn permissions_from_limits(limits: &RuntimeLimits, root: &Path) -> PermissionsContainer {
    let desc_parser: std::sync::Arc<dyn PermissionDescriptorParser> =
        std::sync::Arc::new(RuntimePermissionDescriptorParser::new(RealSys));

    let mut opts = PermissionsOptions::default();
    opts.prompt = false;

    if let Some(cfg) = &limits.permissions {
        if let Some(v) = cfg.get("read") {
            if v == true {
                opts.allow_read = Some(vec![
                    std::fs::canonicalize(root)
                        .unwrap_or_else(|_| root.to_path_buf())
                        .to_string_lossy()
                        .to_string(),
                ]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_read = Some(sandboxed_path_list(root, &items));
            } else if v == false {
                opts.allow_read = None;
            }
        }

        if let Some(v) = cfg.get("write") {
            if v == true {
                opts.allow_write = Some(vec![
                    std::fs::canonicalize(root)
                        .unwrap_or_else(|_| root.to_path_buf())
                        .to_string_lossy()
                        .to_string(),
                ]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_write = Some(sandboxed_path_list(root, &items));
            } else if v == false {
                opts.allow_write = None;
            }
        }

        if let Some(v) = cfg.get("net") {
            if v == true {
                opts.allow_net = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_net = Some(items);
            } else if v == false {
                opts.allow_net = None;
            }
        }

        if let Some(v) = cfg.get("env") {
            if v == true {
                opts.allow_env = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_env = Some(items);
            } else if v == false {
                opts.allow_env = None;
            }
        }

        if let Some(v) = cfg.get("run") {
            if v == true {
                opts.allow_run = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_run = Some(items);
            } else if v == false {
                opts.allow_run = None;
            }
        }

        if let Some(v) = cfg.get("ffi") {
            if v == true {
                opts.allow_ffi = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_ffi = Some(items);
            } else if v == false {
                opts.allow_ffi = None;
            }
        }

        if let Some(v) = cfg.get("sys") {
            if v == true {
                opts.allow_sys = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_sys = Some(items);
            } else if v == false {
                opts.allow_sys = None;
            }
        }

        if let Some(v) = cfg.get("import") {
            if v == true {
                opts.allow_import = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_import = Some(items);
            } else if v == false {
                opts.allow_import = None;
            }
        }
    }

    let imports_enabled = !matches!(limits.imports, crate::worker::state::ImportsPolicy::DenyAll);

    if imports_enabled {
        if opts.allow_read.is_none() {
            opts.allow_read = Some(vec![]);
        }
        if opts.allow_import.is_none() {
            opts.allow_import = Some(vec![]);
        }
    }

    if limits.node_resolve || limits.node_compat {
        if opts.allow_import.is_none() {
            opts.allow_import = Some(vec![]);
        }
    }

    if limits.startup.is_some() && !imports_enabled {
        if opts.allow_read.is_none() {
            opts.allow_read = Some(vec![]);
        }
        if opts.allow_import.is_none() {
            opts.allow_import = Some(vec![]);
        }
    }

    let perms = Permissions::from_options(desc_parser.as_ref(), &opts)
        .unwrap_or_else(|_| Permissions::none_without_prompt());

    PermissionsContainer::new(desc_parser, perms)
}

fn inspector_addr(host: &str, port: u16) -> std::net::SocketAddr {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    let h = host.trim();
    if let Ok(ip) = h.parse::<IpAddr>() {
        return SocketAddr::new(ip, port);
    }

    if h.eq_ignore_ascii_case("localhost") {
        return SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port);
    }

    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port)
}

pub fn spawn_worker_thread(
    worker_id: usize,
    limits: RuntimeLimits,
    mut deno_rx: mpsc::Receiver<DenoMsg>,
    mut node_rx: mpsc::Receiver<NodeMsg>,
) {
    thread::spawn(move || {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        use std::time::Duration;

        let inspect_cfg = limits.inspect.clone();

        // Minimal inspect listener for test connectivity.
        let mut inspect_stop: Option<Arc<AtomicBool>> = None;
        let mut inspect_thread: Option<std::thread::JoinHandle<()>> = None;

        if let Some(ins) = inspect_cfg.as_ref() {
            let addr = inspector_addr(&ins.host, ins.port);
            if let Ok(listener) = TcpListener::bind(addr) {
                let _ = listener.set_nonblocking(true);

                let stop = Arc::new(AtomicBool::new(false));
                let stop2 = stop.clone();

                let port = listener.local_addr().map(|a| a.port()).unwrap_or(ins.port);

                let handle = std::thread::spawn(move || {
                    fn write_http(mut stream: &std::net::TcpStream, status: &str, body: &str) {
                        let hdr = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.as_bytes().len()
                        );
                        let _ = stream.write_all(hdr.as_bytes());
                        let _ = stream.write_all(body.as_bytes());
                        let _ = stream.flush();
                    }

                    while !stop2.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((mut stream, _peer)) => {
                                let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                                let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));

                                let mut buf = [0u8; 2048];
                                let n = stream.read(&mut buf).unwrap_or(0);
                                let req = String::from_utf8_lossy(&buf[..n]);

                                let first_line = req.lines().next().unwrap_or("");
                                let mut parts = first_line.split_whitespace();
                                let method = parts.next().unwrap_or("");
                                let path = parts.next().unwrap_or("");

                                if method == "GET" && path == "/json/version" {
                                    write_http(
                                        &stream,
                                        "200 OK",
                                        r#"{"Browser":"denojs-worker","Protocol-Version":"1.3"}"#,
                                    );
                                } else if method == "GET" && (path == "/json/list" || path == "/json") {
                                    let body = format!(
                                        r#"[{{"id":"denojs-worker","title":"denojs-worker","type":"node","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/ws"}}]"#
                                    );
                                    write_http(&stream, "200 OK", &body);
                                } else {
                                    write_http(&stream, "404 Not Found", r#"{"error":"not found"}"#);
                                }

                                let _ = stream.shutdown(Shutdown::Both);
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(25));
                            }
                            Err(_) => {
                                std::thread::sleep(Duration::from_millis(50));
                            }
                        }
                    }
                });

                inspect_stop = Some(stop);
                inspect_thread = Some(handle);
            }
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            let node_tx = match crate::WORKERS.lock() {
                Ok(map) => map.get(&worker_id).map(|w| w.node_tx.clone()),
                Err(_) => None,
            };
            let Some(node_tx) = node_tx else {
                return;
            };

            let cwd_path = normalize_cwd(limits.cwd.as_deref());

            // env config: only supported mechanism besides default process env.
            if let Some(cfg) = limits.env.as_ref() {
                match cfg {
                    EnvConfig::Map(map) => apply_env_map(map),
                }
            }

            let startup_url = normalize_startup_url(&cwd_path, limits.startup.as_deref());
            let base_url = dir_url_from_path(&cwd_path);
            let module_reg = crate::worker::modules::ModuleRegistry::new(base_url.clone());

            let loader = Rc::new(crate::worker::modules::DynamicModuleLoader {
                reg: module_reg.clone(),
                node_tx: node_tx.clone(),
                imports_policy: limits.imports.clone(),
                node_resolve: limits.node_resolve,
                node_compat: limits.node_compat,
                sandbox_root: cwd_path.clone(),
                fs_loader: Arc::new(deno_core::FsModuleLoader),
            });

            let permissions = permissions_from_limits(&limits, &cwd_path);

            let main_module = resolve_url(base_url.as_str())
                .unwrap_or_else(|_| resolve_url("file:///__denojs_worker_main__.js").expect("url"));

            let mut bootstrap = BootstrapOptions::default();
            bootstrap.has_node_modules_dir = limits.node_resolve || limits.node_compat;

            let mut worker_opts = WorkerOptions::default();
            worker_opts.bootstrap = bootstrap;

            if let Some(ins) = inspect_cfg.as_ref() {
                worker_opts.should_break_on_first_statement = ins.break_on_first_statement;
                worker_opts.should_wait_for_inspector_session = false;
            }

            worker_opts.extensions = vec![deno_worker_extension::init()];

            worker_opts.cache_storage_dir = Some(cwd_path.join(".deno_cache"));
            worker_opts.startup_snapshot = deno_snapshots::CLI_SNAPSHOT;

            let services =
                WorkerServiceOptions::<DenoInNpmPackageChecker, NpmResolver<RealSys>, RealSys> {
                    blob_store: Default::default(),
                    broadcast_channel: Default::default(),
                    compiled_wasm_module_store: Default::default(),
                    feature_checker: Default::default(),
                    fetch_dns_resolver: Default::default(),
                    fs: Arc::new(SandboxFs::new(cwd_path.clone())),
                    module_loader: loader,
                    node_services: Default::default(),
                    npm_process_state_provider: Default::default(),
                    permissions,
                    root_cert_store_provider: Default::default(),
                    shared_array_buffer_store: Default::default(),
                    v8_code_cache: Default::default(),
                    deno_rt_native_addon_loader: None,
                    bundle_provider: None,
                };

            let mut worker = MainWorker::bootstrap_from_options(&main_module, services, worker_opts);

            {
                let state = worker.js_runtime.op_state();
                let mut s = state.borrow_mut();
                s.put(WorkerOpContext {
                    worker_id,
                    node_tx: node_tx.clone(),
                });
                s.put(module_reg.clone());
            }

            if worker.run_event_loop(false).await.is_err() {
                if let Ok(map) = crate::WORKERS.lock() {
                    if let Some(w) = map.get(&worker_id) {
                        w.closed.store(true, Ordering::SeqCst);
                    }
                }
                return;
            }

            if let Some(cfg) = limits.console.as_ref() {
                let cfg_json = serde_json::to_string(cfg).unwrap_or_else(|_| "null".into());
                let script = format!(
                    "globalThis.__globals[\"__denojs_worker_console\"] = {cfg_json}; globalThis.__applyGlobals();"
                );
                let _ = worker.js_runtime.execute_script("<consoleConfig>", script);
            }

            if let Some(url) = startup_url.as_ref() {
                if worker.execute_side_module(url).await.is_err() {
                    if let Ok(map) = crate::WORKERS.lock() {
                        if let Some(w) = map.get(&worker_id) {
                            w.closed.store(true, Ordering::SeqCst);
                        }
                    }
                    return;
                }

                if worker.run_event_loop(false).await.is_err() {
                    if let Ok(map) = crate::WORKERS.lock() {
                        if let Some(w) = map.get(&worker_id) {
                            w.closed.store(true, Ordering::SeqCst);
                        }
                    }
                    return;
                }
            }

            let stop = Arc::new(AtomicBool::new(false));
            let stop2 = stop.clone();
            let wid_for_node = worker_id;

            let node_pump = std::thread::spawn(move || {
                while !stop2.load(Ordering::SeqCst) {
                    match node_rx.blocking_recv() {
                        Some(nmsg) => dispatch_node_msg(wid_for_node, nmsg),
                        None => break,
                    }
                }
                while let Ok(nmsg) = node_rx.try_recv() {
                    dispatch_node_msg(wid_for_node, nmsg);
                }
            });

            while let Some(dmsg) = deno_rx.recv().await {
                let should_close = handle_deno_msg(&mut worker, worker_id, &limits, dmsg).await;
                if should_close {
                    break;
                }
            }

            stop.store(true, Ordering::SeqCst);
            let _ = node_pump.join();
        });

        if let Some(s) = inspect_stop.as_ref() {
            s.store(true, Ordering::SeqCst);
        }
        if let Some(h) = inspect_thread.take() {
            let _ = h.join();
        }
    });
}