"use client";

import { useId, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { cn } from "@/lib/client/utils";

const MAX_BYTES = 1024 * 1024;

/** Drag-and-drop or pick a .csv file; hands back its text. */
export function CsvDropZone({ onText, className, compact = false }: { onText: (text: string, fileName: string) => void; className?: string; compact?: boolean }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function take(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is larger than 1 MB. Split it into smaller files.");
      return;
    }
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text\/plain/.test(file.type)) {
      setError("Choose a .csv file.");
      return;
    }
    const text = await file.text();
    onText(text, file.name);
    if (input.current) input.current.value = "";
  }

  return (
    <div className={className}>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center transition-colors",
          compact ? "px-4 py-6" : "px-6 py-10",
          over ? "border-brand bg-brand-soft" : "border-input hover:border-foreground/30 hover:bg-muted/40",
        )}
      >
        <FileUp className="size-5 text-muted-foreground" strokeWidth={1.75} />
        <span className="text-sm font-medium">Drop a CSV here, or click to choose</span>
        <span className="text-[0.8125rem] text-muted-foreground">Up to 1 MB and 5,000 rows</span>
      </label>
      <input ref={input} id={id} type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void take(e.target.files?.[0])} />
      {error ? (
        <p role="alert" className="mt-2 text-[0.8125rem] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
