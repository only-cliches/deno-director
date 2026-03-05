If I run npm run quick:bench inside the ipc-bench folder I get this outcome:

+------+---------------+--------+------------------------+
| Main | IPC           | Worker |              Bandwidth |
+------+---------------+--------+------------------------+
| Bun  | postMessage   | Bun    |           * 213.4 MB/s |
| Node | postMessage   | Node   |             185.4 MB/s |
| Bun  | HTTP          | Bun    |             160.0 MB/s |
| Node | worker.eval   | Deno   |             128.3 MB/s |
| Deno | postMessage   | Deno   |             111.0 MB/s |
| Deno | HTTP          | Deno   |              43.5 MB/s |
| Node | HTTP          | Node   |               9.9 MB/s |
| Node | worker.handle | Deno   |               0.3 MB/s |
| Node | postMessage   | Deno   |               0.3 MB/s |
+------+---------------+--------+------------------------+

Why is this library so much slower than the other implemtnations?  I'd be ok being in the same order of magnitude as those highly engineered solutions, so lets get there.

Please figure out where the bottlenecks are and get rid of them, rules:
1. Focus on finding and resolving bottlenecks discovered by the benchmark.
2. Only run bench:quick after you've build the library with `npm run build-release`.
3. You are free to: A) Edit any files inside src, B) run npm, cargo, and any simple commands for text searching/editing. C) Add new Rust or Typescript tests.
3. Verify all tests run succesfully.
4. Do not stop working until you've resolved all potential bottlenecks or you've reached roughly the same performance as the other platforms.