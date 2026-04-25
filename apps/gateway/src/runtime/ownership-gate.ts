/** Opaque ownership token for one binding or coordination lease. */
export interface OwnershipLease {
  bindingId: string;
  token: string;
}

/** Lease boundary used by local and Redis runtime ownership implementations. */
export interface OwnershipGate {
  /** Attempts to acquire ownership and returns null when another owner holds it. */
  acquire(bindingId: string): Promise<OwnershipLease | null>;
  /** Refreshes an existing lease and reports whether ownership is still valid. */
  renew(lease: OwnershipLease): Promise<boolean>;
  /** Releases a lease held by the caller. */
  release(lease: OwnershipLease): Promise<void>;
  /** Reports whether any runtime currently holds ownership for the id. */
  isHeld(bindingId: string): Promise<boolean>;
}

/** DI token for the configured ownership gate implementation. */
export const RuntimeOwnershipGate = Symbol.for("runtime.RuntimeOwnershipGate");
