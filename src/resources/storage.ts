// Storage : PVC, PV, Storage Classes.

import { defineResource } from "./descriptor";
import { link, text } from "./format";

const phaseTone = (phase: string | undefined) =>
  phase === "Bound" ? "ok" : phase === "Pending" ? "warning" : phase === "Failed" ? "error" : undefined;

export const persistentvolumeclaims = defineResource({
  id: "persistentvolumeclaims",
  title: "Persistent Volume Claims",
  kindName: "PersistentVolumeClaim",
  namespaced: true,
  columns: [
    { id: "storageClass", title: "Storage class", grow: 0.8, value: (o) => o.spec?.storageClassName ?? "" },
    { id: "size", title: "Size", grow: 0.5, value: (o) => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? "" },
    { id: "volume", title: "Volume", grow: 1.5, value: (o) => link("PersistentVolume", o.spec?.volumeName) },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.5, value: (o) => text(o.status?.phase, phaseTone(o.status?.phase)) }],
  items: (o) => [{ name: "Access Modes", value: (o.spec?.accessModes ?? []).join(", ") }],
});

export const persistentvolumes = defineResource({
  id: "persistentvolumes",
  title: "Persistent Volumes",
  kindName: "PersistentVolume",
  namespaced: false,
  columns: [
    { id: "storageClass", title: "Storage Class", grow: 0.8, value: (o) => o.spec?.storageClassName ?? "" },
    { id: "capacity", title: "Capacity", grow: 0.5, value: (o) => o.spec?.capacity?.storage ?? "" },
    {
      id: "claim",
      title: "Claim",
      grow: 1.4,
      value: (o) =>
        o.spec?.claimRef
          ? link("PersistentVolumeClaim", o.spec.claimRef.name, o.spec.claimRef.namespace, `${o.spec.claimRef.namespace}/`)
          : "",
    },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.5, value: (o) => text(o.status?.phase, phaseTone(o.status?.phase)) }],
  items: (o) => [
    { name: "Access Modes", value: (o.spec?.accessModes ?? []).join(", ") },
    { name: "Reclaim Policy", value: o.spec?.persistentVolumeReclaimPolicy ?? "" },
  ],
});

export const storageclasses = defineResource({
  id: "storageclasses",
  kubectlName: "storageclasses.storage.k8s.io",
  title: "Storage Classes",
  kindName: "StorageClass",
  namespaced: false,
  columns: [
    { id: "provisioner", title: "Provisioner", grow: 1.5, value: (o) => o.provisioner ?? "" },
    { id: "reclaim", title: "Reclaim Policy", grow: 0.6, value: (o) => o.reclaimPolicy ?? "" },
    {
      id: "default",
      title: "Default",
      grow: 0.4,
      value: (o) => (o.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? text("Yes", "ok") : ""),
    },
  ],
});
