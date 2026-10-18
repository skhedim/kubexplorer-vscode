#!/usr/bin/env bash
# Flux add-on of the development cluster: controllers and sample objects in every reconciliation state.
set -euo pipefail
cd "$(dirname "$0")"
CONTEXT="${CONTEXT:-kind-kubexplorer}"
k() { kubectl --context "$CONTEXT" "$@"; }

k apply --server-side -f install.yaml
k -n flux-system wait --for=condition=Available deployment --all --timeout=300s
k apply -f samples.yaml
echo "Flux add-on ready"
