"use client";

import { useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";
import { clearBrowserQueryCache } from "@/lib/query/client";

export function SignOutButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await authClient.signOut();
          } finally {
            // امحُ ذاكرة TanStack ثم حمّل وثيقة جديدة لمسح Router/RSC cache.
            clearBrowserQueryCache();
            window.location.replace("/");
          }
        })
      }
    >
      {pending ? "…" : label}
    </Button>
  );
}
