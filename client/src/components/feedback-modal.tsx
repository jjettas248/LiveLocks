import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { MessageSquare, X, CheckCircle } from "lucide-react";

export function FeedbackModal() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const feedbackMutation = useMutation({
    mutationFn: (msg: string) => apiRequest("POST", "/api/feedback", { message: msg }),
    onSuccess: () => {
      setSubmitted(true);
      setMessage("");
      setTimeout(() => {
        setSubmitted(false);
        setOpen(false);
      }, 2000);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim().length < 3) return;
    feedbackMutation.mutate(message.trim());
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        data-testid="button-open-feedback"
        onClick={() => setOpen(true)}
        title="Send feedback"
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center justify-center hover:bg-primary/90 transition-all hover:scale-105 active:scale-95"
      >
        <MessageSquare className="w-5 h-5" />
      </button>

      {/* Backdrop + modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end p-4 sm:p-6">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-w-sm bg-card border border-border rounded-2xl shadow-2xl p-5 z-10">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Send Feedback</h3>
              </div>
              <button
                data-testid="button-close-feedback"
                onClick={() => setOpen(false)}
                className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {submitted ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <CheckCircle className="w-8 h-8 text-green-500" />
                <p className="text-sm font-medium text-foreground">Thanks for the feedback!</p>
                <p className="text-xs text-muted-foreground">We read every message.</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3">
                <textarea
                  data-testid="input-feedback"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Report a bug, suggest a feature, or just say hi..."
                  rows={4}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
                <button
                  data-testid="button-submit-feedback"
                  type="submit"
                  disabled={message.trim().length < 3 || feedbackMutation.isPending}
                  className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {feedbackMutation.isPending ? (
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : "Send Feedback"}
                </button>
                {feedbackMutation.isError && (
                  <p className="text-xs text-destructive text-center">Failed to send. Try again.</p>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
