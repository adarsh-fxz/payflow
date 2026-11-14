"use client";

import { useState, type ReactNode } from "react";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ThemeProvider, useTheme } from "next-themes";
import { mezoTestnet } from "@/lib/chain/config";
import { wagmiConfig } from "@/lib/client/wagmi";
import { retryDelay, shouldRetry } from "@/lib/client/api";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Passport's connect modal (RainbowKit) in PayFlow's warm neutrals.
const rkLight = lightTheme({ accentColor: "#2b2724", accentColorForeground: "#fbfaf8", borderRadius: "small", fontStack: "system" });
const rkDark = darkTheme({ accentColor: "#f1efec", accentColorForeground: "#2a2622", borderRadius: "small", fontStack: "system" });

function WalletModalProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <RainbowKitProvider theme={resolvedTheme === "dark" ? rkDark : rkLight} initialChain={mezoTestnet} modalSize="compact">
      {children}
    </RainbowKitProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A few attempts with exponential backoff (1s, 2s, 4s), then stop. When Mezo's RPC is
            // down this keeps the app from hammering it; the banners say what is going on instead.
            retry: shouldRetry,
            retryDelay,
            refetchOnWindowFocus: false,
            staleTime: 10_000,
          },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <WalletModalProvider>
            <TooltipProvider delayDuration={200}>
              {children}
              <Toaster position="bottom-right" closeButton />
            </TooltipProvider>
          </WalletModalProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
