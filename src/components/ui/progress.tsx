import { cn } from "@/lib/utils";

interface ProgressProps {
  value: number;       // 0-100
  max?: number;        // defaults to 100
  className?: string;
  indicatorClassName?: string;
}

export function Progress({ value, max = 100, className, indicatorClassName }: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className={cn(
          "h-full bg-primary transition-all duration-500 ease-out",
          indicatorClassName
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
