import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.warn("[email] WARNING: RESEND_API_KEY is not set. Transactional emails will not be sent.");
}

const resend = apiKey ? new Resend(apiKey) : null;

const FROM = "LiveLocks <team@livelocksai.app>";

const UNSUBSCRIBE_URL = "https://livelocksai.app/unsubscribe";
const UNSUBSCRIBE_EMAIL = "unsubscribe@livelocksai.app";

const DELIVERABILITY_HEADERS = {
  "List-Unsubscribe": `<mailto:${UNSUBSCRIBE_EMAIL}>, <${UNSUBSCRIBE_URL}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

function wrap(body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin:0; padding:0; background:#0a0a0a; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .container { max-width:560px; margin:0 auto; padding:40px 24px; }
  .logo { font-size:24px; font-weight:800; color:#ffffff; letter-spacing:-0.5px; margin-bottom:32px; }
  .logo span { color:#00d4aa; }
  h1 { color:#ffffff; font-size:22px; font-weight:700; margin:0 0 16px; }
  p { color:#a1a1aa; font-size:15px; line-height:1.6; margin:0 0 16px; }
  .cta { display:inline-block; background:#00d4aa; color:#0a0a0a; font-weight:700; font-size:15px; padding:12px 28px; border-radius:8px; text-decoration:none; margin:8px 0 24px; }
  .footer { margin-top:40px; padding-top:24px; border-top:1px solid #27272a; }
  .footer p { color:#52525b; font-size:12px; }
  .highlight { color:#00d4aa; font-weight:600; }
  .stat { display:inline-block; background:#111111; border:1px solid #27272a; border-radius:8px; padding:12px 20px; margin:4px 8px 4px 0; }
  .stat-label { color:#71717a; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; }
  .stat-value { color:#ffffff; font-size:18px; font-weight:700; }
</style>
</head>
<body><div class="container"><div class="logo">Live<span>Locks</span></div>${body}<div class="footer"><p>LiveLocks by PropPulse &middot; <a href="https://livelocksai.app" style="color:#52525b;">livelocksai.app</a></p><p><a href="${UNSUBSCRIBE_URL}" style="color:#52525b;">Unsubscribe</a></p></div></div></body></html>`;
}

async function sendHtmlEmail(to: string, subject: string, html: string): Promise<void> {
  if (!resend) {
    console.warn("EMAIL SKIPPED (no API key):", to);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
      headers: DELIVERABILITY_HEADERS,
    });
    console.log("EMAIL SENT:", to, subject);
  } catch (error) {
    console.error("EMAIL FAILED:", to, subject, error);
    throw error;
  }
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>Welcome to LiveLocks</h1>
    <p>You're in. LiveLocks gives you <span class="highlight">real-time edge detection</span> across NBA, NCAAB, and MLB — powered by live data, not guesswork.</p>
    <p>Here's what you get:</p>
    <p>&bull; <strong style="color:#fff;">Live probability signals</strong> updated every 15-20 seconds<br>
       &bull; <strong style="color:#fff;">Edge detection</strong> that compares engine vs. sportsbook pricing<br>
       &bull; <strong style="color:#fff;">Confidence tiers</strong> — ELITE, STRONG, and LEAN rankings<br>
       &bull; <strong style="color:#fff;">Bet card builder</strong> to track your plays</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Open LiveLocks</a>
    <p>Your free tier includes 3 plays per day. Upgrade anytime for unlimited access.</p>
  `);
  await sendHtmlEmail(to, "Welcome to LiveLocks", html);
}

export async function sendHowToEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>How to Use LiveLocks</h1>
    <p>Here's how to get the most out of your edge detection:</p>
    <p><strong style="color:#fff;">1. Check the Live Feed</strong><br>Open the dashboard during game time. Signals update every 15-20 seconds with fresh probability data.</p>
    <p><strong style="color:#fff;">2. Read the Confidence Tiers</strong><br>
       <span class="highlight">ELITE</span> = highest conviction &middot;
       <span style="color:#2dd4bf;font-weight:600;">STRONG</span> = playable edge &middot;
       <span style="color:#a1a1aa;font-weight:600;">LEAN</span> = informational</p>
    <p><strong style="color:#fff;">3. Build Your Bet Card</strong><br>Tap "+ Bet Card" on any signal to add it to your tracking slip.</p>
    <p><strong style="color:#fff;">4. Watch for Halftime</strong><br>2H signals at halftime are often the most actionable — look for the yellow LIVE 2H badges.</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Start Exploring</a>
  `);
  await sendHtmlEmail(to, "How to use LiveLocks", html);
}

export async function sendNudgeEmail(to: string, playsUsed: number, remaining: number): Promise<void> {
  const html = wrap(`
    <h1>Don't Miss Today's Edges</h1>
    <div>
      <div class="stat"><div class="stat-label">Plays Used</div><div class="stat-value">${playsUsed}</div></div>
      <div class="stat"><div class="stat-label">Remaining</div><div class="stat-value">${remaining}</div></div>
    </div>
    <p style="margin-top:16px;">You've been using LiveLocks — nice. There are live edges being surfaced right now across NBA, NCAAB, and MLB.</p>
    <p>Don't let your remaining plays go to waste today.</p>
    <a href="https://livelocksai.app/dashboard" class="cta">See Live Edges</a>
    <p>Want unlimited plays? <a href="https://livelocksai.app/dashboard" style="color:#00d4aa;">Upgrade to Pro</a> for full access.</p>
  `);
  await sendHtmlEmail(to, "Don't miss out on LiveLocks", html);
}

export async function sendWallEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>You've Hit Your Free Play Limit</h1>
    <p>You used all 3 of your free plays today. That means you're engaged — and there's more waiting for you.</p>
    <p>Here's what Pro unlocks:</p>
    <p>&bull; <strong style="color:#fff;">Unlimited plays</strong> — no daily cap<br>
       &bull; <strong style="color:#fff;">All confidence tiers</strong> — ELITE, STRONG, LEAN<br>
       &bull; <strong style="color:#fff;">Multi-sport access</strong> — NBA + NCAAB + MLB<br>
       &bull; <strong style="color:#fff;">Real-time alerts</strong> — SMS & push for top edges</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Upgrade to Pro — $40/mo</a>
    <p>Your plays reset tomorrow. But Pro means you never miss another edge.</p>
  `);
  await sendHtmlEmail(to, "You've hit your free play limit — here's what you missed", html);
}

export async function sendWinbackEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>We Miss You at LiveLocks</h1>
    <p>It's been a while since you checked in. The engine has been running — and there have been some strong signals you might have missed.</p>
    <p>LiveLocks continuously scans live games and surfaces edges in real-time. All you have to do is show up.</p>
    <a href="https://livelocksai.app/dashboard" class="cta">See What You're Missing</a>
    <p>Still on the free tier? <a href="https://livelocksai.app/dashboard" style="color:#00d4aa;">Upgrade to Pro</a> for unlimited plays and all sports.</p>
  `);
  await sendHtmlEmail(to, "We miss you at LiveLocks", html);
}

export async function sendProWelcomeEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>Welcome to Pro</h1>
    <p>You're now a <span class="highlight">LiveLocks Pro</span> member. Here's what's unlocked:</p>
    <p>&bull; <strong style="color:#fff;">Unlimited plays</strong> — no daily limits<br>
       &bull; <strong style="color:#fff;">All confidence tiers</strong> — see every ELITE, STRONG, and LEAN signal<br>
       &bull; <strong style="color:#fff;">Full sport access</strong> — NBA, NCAAB, MLB<br>
       &bull; <strong style="color:#fff;">Priority edge alerts</strong> — get notified on top signals</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Start Using Pro</a>
    <p>Thanks for upgrading. We're here to give you an edge.</p>
  `);
  await sendHtmlEmail(to, "Welcome to Pro", html);
}

export async function sendAllSportsWelcomeEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>Welcome to All Sports</h1>
    <p>You now have <span class="highlight">full access to every sport and every signal</span> LiveLocks offers.</p>
    <p>&bull; <strong style="color:#fff;">NBA, NCAAB, MLB</strong> — all live, all the time<br>
       &bull; <strong style="color:#fff;">Unlimited plays</strong> — no caps, ever<br>
       &bull; <strong style="color:#fff;">Every confidence tier</strong> — ELITE through LEAN<br>
       &bull; <strong style="color:#fff;">Full alert access</strong> — SMS + push for all sports<br>
       &bull; <strong style="color:#fff;">Halftime 2H signals</strong> — the most actionable edges in sports</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Explore All Sports</a>
    <p>You're getting the full LiveLocks experience. Make it count.</p>
  `);
  await sendHtmlEmail(to, "Welcome to All Sports", html);
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  if (!resend) {
    console.warn("EMAIL SKIPPED (no API key):", to);
    return;
  }
  try {
    const verifyUrl = `https://livelocksai.app/api/auth/verify-email?token=${token}`;
    const html = wrap(`
      <h1>Verify Your Email</h1>
      <p>Welcome to LiveLocks! Please verify your email to activate your account.</p>
      <a href="${verifyUrl}" class="cta">Verify Email</a>
      <p>If you didn't create an account, you can safely ignore this email.</p>
    `);
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Verify your LiveLocks email",
      html,
      headers: DELIVERABILITY_HEADERS,
    });
    console.log("EMAIL SENT:", to, "verification");
  } catch (error) {
    console.error("EMAIL FAILED:", to, "verification", error);
    throw error;
  }
}

export async function sendPaymentIssueEmail(to: string): Promise<void> {
  const html = wrap(`
    <h1>Payment Issue</h1>
    <p>We noticed an issue with your LiveLocks subscription payment. Your access may be affected.</p>
    <p>Please update your payment method to continue enjoying full access to live edge detection.</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Update Payment</a>
    <p>If you believe this is an error, please reach out and we'll help sort it out.</p>
  `);
  await sendHtmlEmail(to, "Payment issue with your LiveLocks subscription", html);
}

export async function sendChurnEmail(to: string, previousTier: string): Promise<void> {
  const tierLabel = previousTier === "elite" ? "All Sports" : previousTier === "all" ? "Pro" : "your subscription";
  const html = wrap(`
    <h1>We're Sorry to See You Go</h1>
    <p>Your ${tierLabel} subscription has been cancelled. You'll still have access to the free tier with 3 plays per day.</p>
    <p>If you change your mind, you can re-subscribe anytime to get back to unlimited plays and full sport access.</p>
    <a href="https://livelocksai.app/dashboard" class="cta">Come Back Anytime</a>
    <p>We'd love to know why you left — reply to this email with any feedback.</p>
  `);
  await sendHtmlEmail(to, "Your LiveLocks subscription has been cancelled", html);
}
