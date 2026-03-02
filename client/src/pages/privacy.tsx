import { Link } from "wouter";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border/60 bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <img src={propPulseLogo} alt="LiveLocks" className="w-7 h-7 rounded-lg object-cover" />
          <Link href="/">
            <span className="text-lg font-bold tracking-tight text-foreground cursor-pointer hover:text-primary transition-colors">
              LiveLocks
            </span>
          </Link>
          <span className="text-muted-foreground/40 text-sm ml-1">/</span>
          <span className="text-sm text-muted-foreground">Privacy Policy</span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10">
        <div className="space-y-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-1">Privacy Policy</h1>
            <p className="text-xs text-muted-foreground">Last Updated: March 2026</p>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed">
            LiveLocks AI ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you visit our website (<a href="https://www.livelocksai.app" className="text-primary hover:underline">www.livelocksai.app</a>) and use our services.
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Information We Collect</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We may collect personal information that you voluntarily provide to us when you register for an account, express an interest in obtaining information about us or our products, or otherwise contact us. This includes your name, email address, and phone number.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">SMS Data Sharing and Use</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We respect your privacy. All mobile information you share with LiveLocks AI will remain strictly confidential. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Information sharing to subcontractors in support services, such as customer service, is permitted, but all other use case categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Data Security</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We implement reasonable security measures to protect your personal information. However, no method of transmission over the internet or electronic storage is 100% secure.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Contact Us</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you have questions about this policy, please contact us at{" "}
              <a href="mailto:support@livelocksai.app" className="text-primary hover:underline">
                support@livelocksai.app
              </a>.
            </p>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/60 bg-card/30">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">© 2026 LiveLocks AI. All rights reserved.</p>
          <div className="flex gap-4 text-xs">
            <Link href="/privacy">
              <span className="text-primary hover:underline cursor-pointer">Privacy Policy</span>
            </Link>
            <Link href="/terms">
              <span className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">Terms of Service</span>
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
