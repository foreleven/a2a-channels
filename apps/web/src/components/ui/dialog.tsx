import * as React from "react";

import { cn } from "@/lib/utils";

export function Dialog({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      {children}
    </div>
  );
}

export function DialogContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "max-h-[90vh] w-full overflow-y-auto rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("mb-5 flex flex-col gap-1.5", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-lg font-semibold leading-none tracking-normal", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
