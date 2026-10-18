// Minimal shapes of the Kubernetes sub-objects read by the descriptors.
// Only the fields KubeXplorer uses are declared; every field is optional, as in real API objects.

export interface ContainerPort {
  name?: string;
  containerPort: number;
  protocol?: string;
}

export interface ContainerSpec {
  name: string;
  image?: string;
  command?: string[];
  args?: string[];
  ports?: ContainerPort[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}

export interface ContainerStateDetails {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { exitCode: number; reason?: string; finishedAt?: string };
}

export interface ContainerStatus {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: ContainerStateDetails;
  lastState?: ContainerStateDetails;
}

export interface ServicePort {
  name?: string;
  port: number;
  nodePort?: number;
  targetPort?: number | string;
  protocol?: string;
}

export interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

export interface EndpointSubset {
  addresses?: { ip: string }[];
  ports?: { port?: number }[];
}

export interface IngressRule {
  host?: string;
  http?: { paths?: { path?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[] };
}

export interface IngressTls {
  hosts?: string[];
  secretName?: string;
}

export interface NodeAddress {
  type: string;
  address: string;
}

export interface Taint {
  key: string;
  value?: string;
  effect: string;
}

export interface PolicyRule {
  verbs?: string[];
  resources?: string[];
  nonResourceURLs?: string[];
  apiGroups?: string[];
}

export interface Subject {
  kind: string;
  name: string;
  namespace?: string;
}

export interface LimitRangeItem {
  type: string;
  default?: Record<string, string>;
  defaultRequest?: Record<string, string>;
  max?: Record<string, string>;
  min?: Record<string, string>;
}

export interface Webhook {
  name: string;
  clientConfig?: { url?: string; service?: { namespace: string; name: string; path?: string } };
}

export interface PersistentVolumeClaimTemplate {
  metadata?: { name?: string };
  spec?: { resources?: { requests?: { storage?: string } } };
}

export interface CrdVersion {
  name: string;
  served?: boolean;
  storage?: boolean;
  additionalPrinterColumns?: { name: string; type: string; jsonPath: string; priority?: number }[];
}
