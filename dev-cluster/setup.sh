#!/usr/bin/env bash
# Creates (or updates) the local kind cluster used for development, integration tests and screenshots.
#
#   dev-cluster/setup.sh            # create the cluster and deploy the sample workloads
#   KIND=/path/to/kind dev-cluster/setup.sh
#
# Requirements: docker, kind, kubectl, helm. The script only ever talks to the kind-kubexplorer context.
set -euo pipefail

cd "$(dirname "$0")"
KIND="${KIND:-kind}"
CLUSTER=kubexplorer
CONTEXT="kind-${CLUSTER}"

if ! "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  "$KIND" create cluster --config kind-config.yaml --wait 180s
fi

kubectl --context "$CONTEXT" apply -f sample-workloads.yaml
kubectl --context "$CONTEXT" apply -f metrics-server.yaml
helm upgrade --install shop-landing charts/demo-app --namespace frontend --kube-context "$CONTEXT" --wait --timeout 5m

# Kubeconfig holding only this cluster: tests and screenshots never see any other context.
"$KIND" get kubeconfig --name "$CLUSTER" > ../test/.kubeconfig-kind

kubectl --context "$CONTEXT" -n kube-system rollout status deployment/metrics-server --timeout=180s
echo "Cluster ready: context ${CONTEXT}"
