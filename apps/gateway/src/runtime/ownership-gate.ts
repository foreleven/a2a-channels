export interface OwnershipLease {
  bindingId: string;
  token: string;
}

export interface OwnershipGate {
  acquire(bindingId: string): Promise<OwnershipLease | null>;
  renew(lease: OwnershipLease): Promise<boolean>;
  release(lease: OwnershipLease): Promise<void>;
  isHeld(bindingId: string): Promise<boolean>;
}
