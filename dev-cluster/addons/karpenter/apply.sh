#!/usr/bin/env bash
# Karpenter add-on of the development cluster: CRDs, kwok (simulated nodes), sample objects, statuses and events.
# There is no Karpenter controller: statuses are patched here so that the views have realistic data.
set -euo pipefail
cd "$(dirname "$0")"
CONTEXT="${CONTEXT:-kind-kubexplorer}"
k() { kubectl --context "$CONTEXT" "$@"; }

k apply -f crd-nodepools.yaml -f crd-nodeclaims.yaml -f crd-ec2nodeclasses.yaml
k apply -f kwok.yaml
k apply -f kwok-stage-fast.yaml
k -n kube-system rollout status deployment/kwok-controller --timeout=180s
k wait --for=condition=Established crd/nodepools.karpenter.sh crd/nodeclaims.karpenter.sh crd/ec2nodeclasses.karpenter.k8s.aws
k apply -f samples.yaml

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
condition() { printf '{"type":"%s","status":"%s","reason":"%s","message":"%s","lastTransitionTime":"%s"}' "$1" "$2" "$3" "$4" "$now"; }
patch_status() { k patch "$1" "$2" --subresource=status --type=merge -p "$3" >/dev/null; }

for class in default gpu; do
  patch_status ec2nodeclass "$class" "{\"status\":{
    \"conditions\":[$(condition Ready True Ready "")],
    \"instanceProfile\":\"dev_${class}_instance_profile\",
    \"amis\":[{\"id\":\"ami-0f1e2d3c4b5a69780\",\"name\":\"${class}-ami\",\"requirements\":[{\"key\":\"kubernetes.io/arch\",\"operator\":\"In\",\"values\":[\"amd64\"]}]}],
    \"subnets\":[{\"id\":\"subnet-0aa11\",\"zone\":\"eu-west-3a\",\"zoneID\":\"euw3-az1\"},{\"id\":\"subnet-0bb22\",\"zone\":\"eu-west-3b\",\"zoneID\":\"euw3-az2\"},{\"id\":\"subnet-0cc33\",\"zone\":\"eu-west-3c\",\"zoneID\":\"euw3-az3\"}],
    \"securityGroups\":[{\"id\":\"sg-0dd44\",\"name\":\"dev-nodes\"}]}}"
done

ready_conditions="$(condition Launched True Launched ""),$(condition Registered True Registered ""),$(condition Initialized True Initialized ""),$(condition Ready True Ready "")"
claim() { # name node instance-id cpu memory [extra conditions]
  patch_status nodeclaim "$1" "{\"status\":{
    \"nodeName\":\"$2\",\"providerID\":\"aws:///eu-west-3a/$3\",\"imageID\":\"ami-0f1e2d3c4b5a69780\",
    \"capacity\":{\"cpu\":\"$4\",\"memory\":\"$5\",\"pods\":\"58\"},\"allocatable\":{\"cpu\":\"$4\",\"memory\":\"$5\",\"pods\":\"58\"},
    \"conditions\":[$ready_conditions${6:+,$6}]}}"
}
claim default-x7k2p ip-10-0-1-21.eu-west-3.compute.internal i-0a1b2c3d4e5f60001 2 8Gi
claim default-m4q9z ip-10-0-2-34.eu-west-3.compute.internal i-0a1b2c3d4e5f60002 4 16Gi "$(condition Drifted True NodeClassDrift "NodeClass spec changed (AMI)")"
claim default-c2v8w ip-10-0-3-56.eu-west-3.compute.internal i-0a1b2c3d4e5f60003 2 4Gi "$(condition Consolidatable True Consolidatable "")"
claim gpu-r5t1n ip-10-0-1-78.eu-west-3.compute.internal i-0a1b2c3d4e5f60004 4 16Gi
patch_status nodeclaim gpu-pending-b8d3k "{\"status\":{\"conditions\":[$(condition Launched False InsufficientCapacity "all requested instance types were unavailable during launch"),$(condition Ready False NotLaunched "Node not launched")]}}"

patch_status nodepool default "{\"status\":{\"nodes\":3,\"resources\":{\"cpu\":\"8\",\"memory\":\"28Gi\",\"nodes\":\"3\",\"pods\":\"116\"},
  \"conditions\":[$(condition Ready True Ready ""),$(condition NodeClassReady True NodeClassReady ""),$(condition ValidationSucceeded True ValidationSucceeded "")]}}"
patch_status nodepool gpu "{\"status\":{\"nodes\":1,\"resources\":{\"cpu\":\"4\",\"memory\":\"16Gi\",\"nodes\":\"1\",\"pods\":\"58\",\"nvidia.com/gpu\":\"1\"},
  \"conditions\":[$(condition Ready True Ready ""),$(condition NodeClassReady True NodeClassReady ""),$(condition ValidationSucceeded True ValidationSucceeded "")]}}"

# Scaling decisions, as Karpenter reports them (events expire after an hour: run this script again to refresh them).
event() { # name kind object reason type message
  k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Event
metadata: { name: "$1", namespace: default }
involvedObject: { apiVersion: karpenter.sh/v1, kind: $2, name: "$3" }
reason: $4
type: $5
message: "$6"
source: { component: karpenter }
firstTimestamp: "$now"
lastTimestamp: "$now"
count: 1
EOF
}
event karpenter-launched-x7k2p NodeClaim default-x7k2p Launched Normal "Status condition transitioned, Type: Launched, Status: Unknown -> True"
event karpenter-registered-x7k2p NodeClaim default-x7k2p Registered Normal "Status condition transitioned, Type: Registered, Status: Unknown -> True"
event karpenter-drifted-m4q9z NodeClaim default-m4q9z DisruptionLaunching Normal "Launching NodeClaim: Drifted/Replace"
event karpenter-blocked-c2v8w NodeClaim default-c2v8w DisruptionBlocked Normal "Pdb batch/inflate prevents pod evictions"
event karpenter-failed-gpu NodeClaim gpu-pending-b8d3k FailedLaunch Warning "Launching NodeClaim: all requested instance types were unavailable during launch"
event karpenter-unconsolidatable NodePool default Unconsolidatable Normal "SpotToSpotConsolidation is disabled, can't replace a spot node with a spot node"
echo "Karpenter add-on ready"
