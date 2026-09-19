import os from "node:os";

// Identity of this process as a log writer. In Kubernetes the pod hostname is the
// pod name, so it already distinguishes instances without any configuration; an
// operator can override it with INSTANCE_NAME when the host is not meaningful.
export function getInstanceId() {
  return process.env.INSTANCE_NAME?.trim() || os.hostname() || "unknown";
}
