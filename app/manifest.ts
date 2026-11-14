import type { MetadataRoute } from "next";
import { SITE } from "@/lib/client/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PayFlow",
    short_name: "PayFlow",
    description: SITE.description,
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1f1b18",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512" },
      { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
