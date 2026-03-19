import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.warn("[email] WARNING: RESEND_API_KEY is not set. Transactional emails will not be sent.");
}

const resend = apiKey ? new Resend(apiKey) : null;

const FROM = "LiveLocks <team@livelocksai.app>";

const TEMPLATES = {
  welcome: process.env.RESEND_TEMPLATE_WELCOME || "welcome",
  howto: process.env.RESEND_TEMPLATE_HOWTO || "how-to",
  nudge: process.env.RESEND_TEMPLATE_NUDGE || "nudge",
  wall: process.env.RESEND_TEMPLATE_WALL || "wall",
  winback: process.env.RESEND_TEMPLATE_WINBACK || "winback",
  proWelcome: process.env.RESEND_TEMPLATE_PRO_WELCOME || "pro-welcome",
  allSportsWelcome: process.env.RESEND_TEMPLATE_ALL_SPORTS_WELCOME || "all-sports-welcome",
} as const;

type TemplateSendOptions = {
  from: string;
  to: string;
  subject: string;
  template: {
    id: string;
    variables?: Record<string, string | number>;
  };
};

async function sendTemplateEmail(options: TemplateSendOptions): Promise<void> {
  if (!resend) {
    console.warn("EMAIL SKIPPED (no API key):", options.to);
    return;
  }
  await resend.emails.send(options as Parameters<typeof resend.emails.send>[0]);
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to LiveLocks",
      template: { id: TEMPLATES.welcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendHowToEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "How to use LiveLocks",
      template: { id: TEMPLATES.howto },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendNudgeEmail(to: string, playsUsed: number, remaining: number): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Don't miss out on LiveLocks",
      template: {
        id: TEMPLATES.nudge,
        variables: { plays_used: playsUsed, remaining },
      },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendWallEmail(to: string): Promise<void> {
  if (!resend) {
    console.warn("EMAIL SKIPPED (no API key):", to);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "You've hit your free play limit — here's what you missed",
      html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f0f0f0;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="margin-bottom:24px;">
      <span style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#00ff87;">LIVELOCKS — BY PROPPULSE</span>
    </div>
    <h1 style="font-size:28px;font-weight:800;color:#ffffff;margin:0 0 16px;">You've used all 3 free plays.</h1>
    <p style="font-size:16px;color:#aaaaaa;margin:0 0 24px;line-height:1.6;">
      While you were at the limit, the model kept running. Here's what it did yesterday:
    </p>
    <img src="https://livelocksai.app/roi-march-16.png" width="100%" style="border-radius:10px;margin:0 0 24px;display:block;max-width:100%;" alt="ROI Transparency - March 16" />
    <div style="background:#111;border:1px solid #222;border-radius:10px;padding:24px;margin-bottom:24px;">
      <p style="font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#00ff87;margin:0 0 16px;">Model results — March 16</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:120px;">
          <div style="font-size:28px;font-weight:900;color:#00ff87;">+$1,053.75</div>
          <div style="font-size:12px;color:#888;margin-top:4px;">PROFIT</div>
        </div>
        <div style="flex:1;min-width:120px;">
          <div style="font-size:28px;font-weight:900;color:#ffffff;">79.3%</div>
          <div style="font-size:12px;color:#888;margin-top:4px;">HIT RATE</div>
        </div>
        <div style="flex:1;min-width:120px;">
          <div style="font-size:28px;font-weight:900;color:#ffffff;">+51.4%</div>
          <div style="font-size:12px;color:#888;margin-top:4px;">ROI</div>
        </div>
      </div>
      <p style="font-size:13px;color:#888;margin:20px 0 0;font-style:italic;">Every play documented. Wins and losses both posted. No cherry picking.</p>
    </div>
    <p style="font-size:15px;color:#cccccc;margin:0 0 28px;line-height:1.6;">
      By the time the line moves — you're already on it. Upgrade to Pro and get back in the game.
    </p>
    <a href="https://livelocksai.app" style="display:inline-block;background:#00ff87;color:#000000;font-weight:800;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.5px;">Upgrade to Pro — $40/mo</a>
    <p style="font-size:12px;color:#555;margin:32px 0 0;line-height:1.5;">
      LiveLocks by PropPulse · <a href="https://livelocksai.app" style="color:#555;">livelocksai.app</a>
    </p>
  </div>
</body>
</html>`,
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendWinbackEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "We miss you at LiveLocks",
      template: { id: TEMPLATES.winback },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendProWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to Pro",
      template: { id: TEMPLATES.proWelcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendAllSportsWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to All Sports",
      template: { id: TEMPLATES.allSportsWelcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  try {
    if (!resend) {
      console.warn("EMAIL SKIPPED (no API key):", to);
      return;
    }
    const verifyUrl = `https://livelocksai.app/api/auth/verify-email?token=${token}`;
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Verify your LiveLocks email",
      html: `<p>Welcome to LiveLocks! Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>If you didn't create an account, you can safely ignore this email.</p>`,
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendPaymentIssueEmail(to: string): Promise<void> {
  try {
    if (!resend) {
      console.warn("EMAIL SKIPPED (no API key):", to);
      return;
    }
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Payment issue with your LiveLocks subscription",
      html: `<p>We noticed an issue with your LiveLocks subscription payment. Please update your payment method to continue enjoying full access.</p><p>Visit <a href="https://livelocksai.app">LiveLocks</a> to manage your account.</p>`,
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}
