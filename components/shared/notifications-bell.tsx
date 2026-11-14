"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { qk, useNotifications } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";

export function NotificationsBell() {
  const mounted = useMounted();
  const auth = useAuth();
  const enabled = mounted && auth.signedIn;
  const q = useNotifications(enabled);
  const qc = useQueryClient();
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api<unknown>("/api/notifications/read", { method: "POST", json: ids ? { ids } : { all: true } }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  });

  if (!enabled) return null;
  const items = q.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread > 9 ? "9+" : unread} unread` : "Notifications"}
          className="relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
        >
          <Bell className="size-4" strokeWidth={1.75} />
          {unread ? (
            <span aria-hidden className="num absolute top-1 right-1 min-w-4 rounded-full bg-brand px-1 text-center text-[0.625rem] leading-4 font-semibold text-[oklch(0.2_0.01_60)]">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          {unread ? (
            <button type="button" onClick={() => markRead.mutate(undefined)} className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Mark all read
            </button>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {q.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : q.isError ? (
            <p className="p-4 text-sm text-muted-foreground">Couldn&apos;t load notifications.</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing yet. Updates about runs and payments show up here.</p>
          ) : (
            <ul className="divide-y">
              {items.slice(0, 30).map((n) => {
                const body = (
                  <>
                    <p className={cn("text-sm", !n.readAt && "font-medium")}>{n.title}</p>
                    {n.body ? <p className="mt-0.5 line-clamp-2 text-[0.8125rem] text-muted-foreground">{n.body}</p> : null}
                    <p className="mt-1 text-xs text-muted-foreground">{relativeTime(n.createdAt)}</p>
                  </>
                );
                return (
                  <li key={n.id} className={cn(!n.readAt && "bg-brand-soft/50")}>
                    {n.link ? (
                      <Link href={n.link} onClick={() => !n.readAt && markRead.mutate([n.id])} className="block px-4 py-3 hover:bg-muted">
                        {body}
                      </Link>
                    ) : (
                      <div className="px-4 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
