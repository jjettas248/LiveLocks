export function DashboardPreview() {
  return (
    <div data-testid="dashboard-preview" className="mx-auto max-w-5xl rounded-xl border border-neutral-800 shadow-2xl overflow-hidden">
      <img
        src="/dashboard-preview.png"
        alt="LiveLocks dashboard showing live NBA prop predictions with probability edges and ranked 2H plays"
        className="w-full h-auto"
        loading="lazy"
      />
    </div>
  );
}
