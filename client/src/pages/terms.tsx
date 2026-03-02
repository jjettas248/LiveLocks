import { Link } from "wouter";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

export default function TermsPage() {
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
          <span className="text-sm text-muted-foreground">Terms of Service</span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10">
        <div className="space-y-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-1">Terms of Service</h1>
            <p className="text-xs text-muted-foreground">Last Updated: March 2026</p>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed">
            Welcome to LiveLocks AI. By accessing or using our website and services at{" "}
            <a href="https://www.livelocksai.app" className="text-primary hover:underline">www.livelocksai.app</a>,
            you agree to be bound by these Terms of Service.
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Service Description & Disclaimer</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              LiveLocks AI provides sports analytics and data tools for entertainment and informational purposes only. We are not a sportsbook and do not accept wagers. We do not guarantee the accuracy of our data or any specific outcomes. You are solely responsible for how you use this information.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">SMS Text Messaging Terms</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              By opting in to receive text messages from LiveLocks AI, you agree to the following terms:
            </p>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Program Description:</span>
                <span className="leading-relaxed">You will receive sports analytics alerts, probability updates, and account notifications (such as OTPs).</span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Message Frequency:</span>
                <span className="leading-relaxed">Message frequency varies based on live game schedules and your alert preferences.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Pricing:</span>
                <span className="leading-relaxed">Message and data rates may apply.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Opt-Out:</span>
                <span className="leading-relaxed">
                  You may opt out of receiving text messages at any time. Reply <strong className="text-foreground">STOP</strong> to cancel. After you send the SMS message "STOP" to us, we will send you an SMS message to confirm that you have been unsubscribed. After this, you will no longer receive SMS messages from us.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Help:</span>
                <span className="leading-relaxed">
                  If you are experiencing issues with the messaging program, you can reply with the keyword <strong className="text-foreground">HELP</strong> for more assistance, or get help directly at{" "}
                  <a href="mailto:support@livelocksai.app" className="text-primary hover:underline">support@livelocksai.app</a>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary font-semibold shrink-0 mt-0.5">Carrier Liability:</span>
                <span className="leading-relaxed">Carriers are not liable for delayed or undelivered messages.</span>
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Governing Law</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              These Terms shall be governed by and defined following the laws of the State of Florida. LiveLocks AI and yourself irrevocably consent that the courts of Florida shall have exclusive jurisdiction to resolve any dispute which may arise in connection with these terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground border-b border-border pb-2">Contact Us</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              For any questions regarding these terms, contact{" "}
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
              <span className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">Privacy Policy</span>
            </Link>
            <Link href="/terms">
              <span className="text-primary hover:underline cursor-pointer">Terms of Service</span>
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
