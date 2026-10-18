#!/usr/bin/env bash
# Prometheus add-on of the development cluster, for the metric charts (metrics-server alone keeps a short history).
set -euo pipefail
cd "$(dirname "$0")"
CONTEXT="${CONTEXT:-kind-kubexplorer}"

helm upgrade --install prometheus oci://ghcr.io/prometheus-community/charts/prometheus --version 29.37.0 \
  --namespace monitoring --create-namespace --kube-context "$CONTEXT" --values values.yaml --wait --timeout 5m
echo "Prometheus add-on ready"
