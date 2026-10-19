#!/usr/bin/env bash
# A mini fleet for the Fleet tab: four small kind clusters named after their group (prod, dev), each running Flux
# (source, kustomize and helm controllers only) and the same podinfo application, with the drifts the tab finds:
#   fleet-prod-1  the reference
#   fleet-prod-2  the podinfo Kustomization suspended
#   fleet-dev-1   an older Git tag and chart version than fleet-dev-2 (revision drift in the dev group)
#   fleet-dev-2   a failing Kustomization that fleet-dev-1 does not have
# Memory: about 1 GB per cluster.
#
#   dev-cluster/fleet/setup.sh            # create or update the fleet
#   dev-cluster/fleet/setup.sh --delete   # delete it
#   KIND=/path/to/kind dev-cluster/fleet/setup.sh
#
# The clusters are added to the kubeconfig without changing its current context, and to test/.kubeconfig-fleet,
# which the integration tests and screenshots use next to test/.kubeconfig-kind. Only kind-fleet-* contexts are used.
set -euo pipefail
cd "$(dirname "$0")"
KIND="${KIND:-kind}"
CLUSTERS=(fleet-prod-1 fleet-prod-2 fleet-dev-1 fleet-dev-2)
OUT=../../test/.kubeconfig-fleet

if [[ "${1:-}" == "--delete" ]]; then
  for c in "${CLUSTERS[@]}"; do "$KIND" delete cluster --name "$c"; done
  rm -f "$OUT"
  exit 0
fi

previous=$(kubectl config current-context 2>/dev/null || true)
for c in "${CLUSTERS[@]}"; do
  "$KIND" get clusters 2>/dev/null | grep -qx "$c" || "$KIND" create cluster --name "$c" --config kind-config.yaml --wait 180s
done
# kind makes the cluster it creates the current context: put the previous one back.
if [[ -n "$previous" ]]; then kubectl config use-context "$previous" >/dev/null; fi

for c in "${CLUSTERS[@]}"; do
  ctx="kind-$c"
  k() { kubectl --context "$ctx" "$@"; }
  tag=6.9.2 chart=6.9.2 suspend=false
  case "$c" in
    fleet-prod-2) suspend=true ;;
    fleet-dev-1) tag=6.9.1 chart=6.9.0 ;;
  esac
  k apply --server-side -f ../addons/flux/install.yaml >/dev/null
  # Only what the fleet needs: sources, Kustomizations and Helm releases.
  k -n flux-system delete deployment image-automation-controller image-reflector-controller notification-controller source-watcher \
    --ignore-not-found >/dev/null
  k -n flux-system wait --for=condition=Available deployment --all --timeout=300s >/dev/null
  sed -e "s/__TAG__/$tag/" -e "s/__CHART__/$chart/" -e "s/__SUSPEND__/$suspend/" samples.yaml | k apply -f - >/dev/null
  if [[ "$c" == fleet-dev-2 ]]; then k apply -f broken.yaml >/dev/null; fi
  echo "$ctx: Flux and podinfo $tag (chart $chart)"
done

# Kubeconfig of the fleet only: tests and screenshots never see any other context.
files=()
for c in "${CLUSTERS[@]}"; do
  f=$(mktemp)
  "$KIND" get kubeconfig --name "$c" > "$f"
  files+=("$f")
done
KUBECONFIG=$(IFS=:; echo "${files[*]}") kubectl config view --flatten > "$OUT"
rm -f "${files[@]}"
echo "Fleet ready: ${CLUSTERS[*]}"
