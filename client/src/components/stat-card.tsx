import { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  highlight?: "positive" | "negative" | "neutral";
}

export function StatCard({ title, value, subtitle, icon, highlight = "neutral" }: StatCardProps) {
  let valueColor = "text-foreground";
  if (highlight === "positive") valueColor = "text-[#22c55e]";
  if (highlight === "negative") valueColor = "text-[#e11d48]";

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-5 flex flex-col h-full hover:bg-card/80 transition-colors">
      <div className="flex justify-between items-start mb-2">
        <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
        {icon && <div className="text-muted-foreground/70">{icon}</div>}
      </div>
      <div className="mt-auto">
        <div className={`text-3xl font-display font-bold ${valueColor}`}>{value}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
      </div>
    </div>
  );
}
