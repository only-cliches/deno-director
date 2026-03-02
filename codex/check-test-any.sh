#!/usr/bin/env bash
set -euo pipefail

if rg -n "as any" test-ts >/tmp/deno_director_test_any_hits.txt; then
  echo "Found forbidden 'as any' usage in test-ts:"
  cat /tmp/deno_director_test_any_hits.txt
  exit 1
fi

echo "No forbidden 'as any' usage found in test-ts."
