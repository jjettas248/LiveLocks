import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { HrBoardStudio } from "@/components/admin/HrBoardStudio";

/** Admin-only route: /admin/hr-board-studio. Guards on `user.isAdmin`. */
export default function HrBoardStudioPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!authLoading && (!user || !user.isAdmin)) {
      navigate("/dashboard");
    }
  }, [user, authLoading, navigate]);

  if (authLoading || !user?.isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return <HrBoardStudio />;
}
